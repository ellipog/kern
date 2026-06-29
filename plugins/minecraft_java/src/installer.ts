/**
 * installer.ts — Auto-install orchestrator for all server types.
 */

import { downloadWithProgress, type DownloadCallbacks } from "./downloadManager";
import {
  resolvePaperBuild,
  resolvePurpurBuild,
  resolveForgeVersion,
  resolveNeoForgeVersion,
  fetchFabricVersions,
  fetchQuiltVersions,
} from "./versionFetcher";
import type { HostAPI, InstallStep } from "./types";

export interface InstallCallbacks {
  onStepUpdate: (steps: InstallStep[]) => void;
  onLog: (line: string) => void;
  onComplete: (success: boolean, message: string) => void;
}

export async function runInstall(
  serverId: string,
  runtime: string,
  mcVersion: string,
  javaPath: string,
  hostAPI: HostAPI,
  cb: InstallCallbacks,
): Promise<void> {
  const serverPath = hostAPI.serverPath;
  const steps: InstallStep[] = [];

  function addStep(label: string): number {
    const idx = steps.length;
    steps.push({ label, status: "pending" });
    cb.onStepUpdate([...steps]);
    return idx;
  }

  function setStep(idx: number, status: InstallStep["status"], message?: string) {
    steps[idx] = { ...steps[idx], status, message };
    cb.onStepUpdate([...steps]);
  }

  async function download(url: string, dest: string, stepIdx: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      downloadWithProgress(url, dest, hostAPI.invoke, {
        onComplete() {
          setStep(stepIdx, "done", "downloaded");
          resolve();
        },
        onError(err) {
          setStep(stepIdx, "error", err);
          reject(new Error(err));
        },
      });
    });
  }

  async function runCmd(args: string[], stepIdx: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      cb.onLog(`> ${javaPath} ${args.join(" ")}`);
      setStep(stepIdx, "running", "executing…");

      hostAPI
        .invoke("run_instance_command", {
          id: serverId,
          command: javaPath,
          args,
        })
        .then(() => {
          setStep(stepIdx, "done", "completed");
          resolve();
        })
        .catch((err: unknown) => {
          setStep(stepIdx, "error", String(err));
          reject(new Error(String(err)));
        });
    });
  }

  async function writeFile(relPath: string, content: string): Promise<void> {
    await hostAPI.invoke("write_server_file", {
      id: serverId,
      relPath,
      content,
    });
  }

  // -----------------------------------------------------------------------
  //  Common: accept EULA
  // -----------------------------------------------------------------------
  const eulaStep = addStep("Accept EULA");
  try {
    setStep(eulaStep, "running");
    await writeFile("eula.txt", "eula=true\n");
    setStep(eulaStep, "done");
    cb.onLog("EULA accepted");
  } catch (e) {
    setStep(eulaStep, "error", String(e));
    cb.onComplete(false, `Failed to write EULA: ${e}`);
    return;
  }

  const jarPath = `${serverPath}/server.jar`;

  try {
    switch (runtime) {
      case "vanilla": {
        const dlStep = addStep("Download vanilla server.jar");
        const url = await resolveVanillaUrl(mcVersion);
        if (!url) {
          setStep(dlStep, "error", `No download URL for MC ${mcVersion}`);
          cb.onComplete(false, `Could not find vanilla ${mcVersion} download URL`);
          return;
        }
        await download(url, jarPath, dlStep);
        break;
      }

      case "paper": {
        const dlStep = addStep("Download Paper server.jar");
        const build = await resolvePaperBuild(mcVersion);
        if (!build) {
          setStep(dlStep, "error", `No build found for Paper ${mcVersion}`);
          cb.onComplete(false, `Could not resolve Paper build for ${mcVersion}`);
          return;
        }
        const url = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${build.build}/downloads/paper-${mcVersion}-${build.build}.jar`;
        await download(url, jarPath, dlStep);
        break;
      }

      case "purpur": {
        const dlStep = addStep("Download Purpur server.jar");
        const build = await resolvePurpurBuild(mcVersion);
        if (!build) {
          setStep(dlStep, "error", `No build found for Purpur ${mcVersion}`);
          cb.onComplete(false, `Could not resolve Purpur build for ${mcVersion}`);
          return;
        }
        const url = `https://api.purpurmc.org/v2/purpur/${mcVersion}/${build.build}/download`;
        await download(url, jarPath, dlStep);
        break;
      }

      case "fabric": {
        const fetchStep = addStep("Fetch Fabric versions");
        setStep(fetchStep, "running");
        const fabric = await fetchFabricVersions();
        setStep(fetchStep, "done");

        const installerVer = fabric.installerVersion ?? "1.0.0";
        const loaderVer = fabric.loaderVersions[0] ?? "0.16.0";

        const installerJar = `${serverPath}/fabric-installer.jar`;
        const dlStep = addStep("Download Fabric installer");
        const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVer}/fabric-installer-${installerVer}.jar`;
        await download(installerUrl, installerJar, dlStep);

        const runStep = addStep("Run Fabric installer");
        await runCmd([
          "-jar", "fabric-installer.jar",
          "server",
          "-mcversion", mcVersion,
          "-loader", loaderVer,
          "-downloadMinecraft",
        ], runStep);
        break;
      }

      case "forge": {
        const resolveStep = addStep("Resolve Forge version");
        setStep(resolveStep, "running");
        const forgeVer = await resolveForgeVersion(mcVersion);
        if (!forgeVer) {
          setStep(resolveStep, "error", `No Forge version for MC ${mcVersion}`);
          cb.onComplete(false, `Could not resolve Forge version for ${mcVersion}`);
          return;
        }
        setStep(resolveStep, "done", forgeVer);

        const installerJar = `${serverPath}/forge-installer.jar`;
        const dlStep = addStep("Download Forge installer");
        const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVer}/forge-${forgeVer}-installer.jar`;
        await download(installerUrl, installerJar, dlStep);

        const runStep = addStep("Run Forge installer");
        await runCmd(["-jar", "forge-installer.jar", "--installServer"], runStep);
        break;
      }

      case "neoforge": {
        const resolveStep = addStep("Resolve NeoForge version");
        setStep(resolveStep, "running");
        const neoforgeVer = await resolveNeoForgeVersion(mcVersion);
        if (!neoforgeVer) {
          setStep(resolveStep, "error", `No NeoForge version for MC ${mcVersion}`);
          cb.onComplete(false, `Could not resolve NeoForge version for ${mcVersion}`);
          return;
        }
        setStep(resolveStep, "done", neoforgeVer);

        const installerJar = `${serverPath}/neoforge-installer.jar`;
        const dlStep = addStep("Download NeoForge installer");
        const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVer}/neoforge-${neoforgeVer}-installer.jar`;
        await download(installerUrl, installerJar, dlStep);

        const runStep = addStep("Run NeoForge installer");
        await runCmd(["-jar", "neoforge-installer.jar", "--install-server"], runStep);
        break;
      }

      case "quilt": {
        const fetchStep = addStep("Fetch Quilt versions");
        setStep(fetchStep, "running");
        const quilt = await fetchQuiltVersions();
        setStep(fetchStep, "done");

        const installerVer = quilt.installerVersion ?? "0.9.0";
        const loaderVer = quilt.loaderVersions[0] ?? "0.26.0";

        const installerJar = `${serverPath}/quilt-installer.jar`;
        const dlStep = addStep("Download Quilt installer");
        const installerUrl = `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVer}/quilt-installer-${installerVer}.jar`;
        await download(installerUrl, installerJar, dlStep);

        const runStep = addStep("Run Quilt installer");
        await runCmd([
          "-jar", "quilt-installer.jar",
          "install", "server", mcVersion,
          "--loader=" + loaderVer,
        ], runStep);
        break;
      }

      default: {
        cb.onComplete(false, `Unknown runtime: ${runtime}`);
        return;
      }
    }
  } catch (e) {
    cb.onLog(`ERROR: ${e}`);
    cb.onComplete(false, String(e));
    return;
  }

  // Write server.properties with port from overrides
  const cfgStep = addStep("Write server.properties");
  try {
    setStep(cfgStep, "running");
    const port = await hostAPI
      .invoke("read_server_file", { id: serverId, relPath: ".env" })
      .then((content: unknown) => {
        const str = String(content ?? "");
        const match = str.match(/server_port=(\d+)/);
        return match ? match[1] : "25565";
      })
      .catch(() => "25565");

    await writeFile(
      "server.properties",
      [
        "# Minecraft server properties",
        "# Auto-generated by Kern minecraft_java plugin",
        `server-port=${port}`,
        "motd=A Minecraft Server",
        "gamemode=survival",
        "difficulty=easy",
        "max-players=20",
        "online-mode=true",
        "allow-flight=false",
        "white-list=false",
      ].join("\n") + "\n",
    );
    setStep(cfgStep, "done");
  } catch (e) {
    setStep(cfgStep, "error", String(e));
    cb.onLog(`WARN: failed to write server.properties: ${e}`);
  }

  cb.onLog("✅  Install complete!");
  cb.onComplete(true, "Server installed successfully. You can now start it.");
}

async function resolveVanillaUrl(mcVersion: string): Promise<string | null> {
  try {
    const res = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
    const manifest: {
      latest: { release: string; snapshot: string };
      versions: Array<{ id: string; type: string; url: string }>;
    } = await res.json();

    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (!entry) return null;

    const detailRes = await fetch(entry.url);
    const detail: { downloads: { server: { url: string } } } = await detailRes.json();
    return detail.downloads.server.url;
  } catch {
    return null;
  }
}
