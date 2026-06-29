/**
 * versionFetcher.ts — Fetches available version lists from all major
 * Minecraft server platforms via their public APIs.
 */

export interface VersionInfo {
  version: string;
  type: "release" | "snapshot" | "beta" | "alpha";
}

export interface BuildInfo {
  build: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Platform-specific fetch functions
// ---------------------------------------------------------------------------

/** Fetches vanilla (Mojang) versions, optionally including snapshots. */
export async function fetchVanillaVersions(
  includeSnapshots = false,
): Promise<VersionInfo[]> {
  const res = await fetch(
    "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
  );
  const data: {
    latest: { release: string; snapshot: string };
    versions: Array<{ id: string; type: string; url: string; time: string }>;
  } = await res.json();

  if (includeSnapshots) {
    return data.versions
      .filter((v) =>
        v.type === "release" ||
        v.type === "snapshot" ||
        v.type === "old_beta" ||
        v.type === "old_alpha",
      )
      .map((v) => ({
        version: v.id,
        type: v.type as VersionInfo["type"],
      }));
  }

  return data.versions
    .filter((v) => v.type === "release")
    .map((v) => ({
      version: v.id,
      type: "release" as const,
    }));
}

/** Fetches available Paper versions. */
export async function fetchPaperVersions(): Promise<VersionInfo[]> {
  const res = await fetch("https://api.papermc.io/v2/projects/paper");
  const data: { project_id: string; project_name: string; version_groups: string[]; versions: string[] } =
    await res.json();

  return data.versions
    .filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v))
    .map((v) => ({
      version: v,
      type: "release" as const,
    }));
}

/** Resolves the latest build number for a Paper version. */
export async function resolvePaperBuild(
  version: string,
): Promise<BuildInfo | null> {
  try {
    const res = await fetch(
      `https://api.papermc.io/v2/projects/paper/versions/${version}/builds`,
    );
    const data: {
      project_id: string;
      project_name: string;
      version: string;
      builds: Array<{
        build: number;
        time: string;
        channel: string;
        downloads: { application: { name: string } };
      }>;
    } = await res.json();

    const builds = data.builds.filter((b) => b.channel === "default");
    if (builds.length === 0) return null;
    const latest = builds[builds.length - 1];
    return { build: latest.build, label: String(latest.build) };
  } catch {
    return null;
  }
}

/** Fetches available Purpur versions. */
export async function fetchPurpurVersions(): Promise<VersionInfo[]> {
  const res = await fetch("https://api.purpurmc.org/v2/purpur");
  // Purpur v2 API returns { versions: ["1.20.1", ...] } directly.
  const data: { versions: string[] } = await res.json();

  return (data.versions ?? [])
    .filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v))
    .map((v) => ({
      version: v,
      type: "release" as const,
    }));
}

/** Resolves the latest build for a Purpur version. */
export async function resolvePurpurBuild(
  version: string,
): Promise<BuildInfo | null> {
  try {
    const res = await fetch(
      `https://api.purpurmc.org/v2/purpur/${version}`,
    );
    const data: { builds: { latest: string; all: Record<string, number> } } =
      await res.json();
    const latest = data.builds.latest;
    return { build: Number(latest), label: latest };
  } catch {
    return null;
  }
}

/** Fetches Fabric loader & installer versions. */
export async function fetchFabricVersions(
  includeUnstable = false,
): Promise<{
  gameVersions: VersionInfo[];
  loaderVersions: string[];
  installerVersion: string | null;
}> {
  const res = await fetch("https://meta.fabricmc.net/v2/versions");
  const data: {
    game: Array<{ version: string; stable: boolean }>;
    loader: Array<{ version: string; stable: boolean }>;
    installer: Array<{ version: string; stable: boolean }>;
  } = await res.json();

  return {
    gameVersions: data.game
      .filter((v) => includeUnstable || v.stable)
      .map((v) => ({
        version: v.version,
        type: v.stable ? ("release" as const) : ("snapshot" as const),
      })),
    loaderVersions: data.loader
      .filter((v) => v.stable)
      .map((v) => v.version),
    installerVersion: data.installer.find((v) => v.stable)?.version ?? null,
  };
}

/** Fetches Forge version mappings from the promotions API. */
export async function fetchForgeVersions(): Promise<
  Array<{ mcVersion: string; forgeVersion: string }>
> {
  // Forge's promotions API sends NO CORS headers, so a direct browser fetch
  // is rejected. Fall back to the Rust proxy (fetch_mc_versions) when this
  // throws — the caller (fetchVersionsForRuntime) handles that path.
  const res = await fetch(
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
  );
  const data: { promos: Record<string, string> } = await res.json();

  const entries: Array<{ mcVersion: string; forgeVersion: string }> = [];
  for (const [key, value] of Object.entries(data.promos)) {
    const dashIdx = key.lastIndexOf("-");
    if (dashIdx === -1) continue;
    const mcVer = key.slice(0, dashIdx);
    const suffix = key.slice(dashIdx + 1);
    if (suffix === "recommended" || suffix === "latest") {
      entries.push({ mcVersion: mcVer, forgeVersion: value });
    }
  }
  return entries;
}

export async function resolveForgeVersion(
  mcVersion: string,
): Promise<string | null> {
  const entries = await fetchForgeVersions();
  const recommended = entries.find(
    (e) => e.mcVersion === mcVersion,
  );
  return recommended?.forgeVersion ?? null;
}

/** Fetches NeoForge versions from the Maven versions endpoint. */
export async function fetchNeoForgeVersions(): Promise<VersionInfo[]> {
  // NeoForge's old meta API (api.neoforged.net) no longer resolves. The Maven
  // versions endpoint lists build names like "20.2.3-beta" or "26.1.2.71" —
  // the first two numeric segments encode the MC version (20.2 → 1.20.2).
  const res = await fetch(
    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
  );
  const data: { versions: string[] } = await res.json();

  const seen = new Set<string>();
  const result: VersionInfo[] = [];
  for (const build of data.versions ?? []) {
    const m = build.match(/^(\d+)\.(\d+)/);
    if (!m) continue;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    // Pre-2025 naming: 20.x → 1.20.x. 2026+ keeps the MC version as-is.
    const mc = major >= 21 ? `${major}.${minor}` : `1.${major}.${minor}`;
    if (!seen.has(mc)) {
      seen.add(mc);
      result.push({ version: mc, type: "release" });
    }
  }
  return result;
}

export async function resolveNeoForgeVersion(
  mcVersion: string,
): Promise<string | null> {
  // Derive the latest NeoForge build label for a given MC version from the
  // Maven versions endpoint (the per-MC meta API is also dead).
  try {
    const res = await fetch(
      "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    );
    const data: { versions: string[] } = await res.json();
    // Convert the MC version to the NeoForge major.minor prefix.
    // "1.20.2" → "20.2", "26.1" → "26.1".
    const parts = mcVersion.split(".").map(Number);
    let prefix: string;
    if (parts[0] === 1) {
      prefix = `${parts[1]}.${parts[2] ?? 0}`;
    } else {
      prefix = `${parts[0]}.${parts[1] ?? 0}`;
    }
    // Pick the highest non-beta build matching the prefix.
    const matches = (data.versions ?? [])
      .filter((v) => v.startsWith(prefix + ".") && !v.endsWith("-beta"))
      .sort();
    if (matches.length === 0) return null;
    return matches[matches.length - 1];
  } catch {
    return null;
  }
}

/**
 * Fetches versions appropriate for a given server runtime.
 * Returns sorted newest-first with deduplication.
 *
 * For runtimes whose APIs send no CORS headers (Forge), falls back to the
 * Rust `fetch_mc_versions` proxy command via the hostAPI invoke function.
 */
export async function fetchVersionsForRuntime(
  runtime: string,
  includeSnapshots: boolean,
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<VersionInfo[]> {
  let versions: VersionInfo[] = [];

  try {
    switch (runtime) {
      case "vanilla":
        versions = await fetchVanillaVersions(includeSnapshots);
        break;
      case "paper":
        versions = await fetchPaperVersions();
        break;
      case "purpur":
        versions = await fetchPurpurVersions();
        break;
      case "fabric": {
        const fabric = await fetchFabricVersions(includeSnapshots);
        versions = fabric.gameVersions;
        break;
      }
      case "forge":
        versions = (await fetchForgeVersions()).map((e) => ({
          version: e.mcVersion,
          type: "release" as const,
        }));
        break;
      case "neoforge":
        versions = await fetchNeoForgeVersions();
        break;
      case "quilt": {
        const quilt = await fetchQuiltVersions(includeSnapshots);
        versions = quilt.gameVersions;
        break;
      }
      default:
        versions = await fetchVanillaVersions(includeSnapshots);
    }
  } catch (corsErr) {
    // Direct fetch failed (likely CORS for Forge). Fall back to the Rust
    // proxy if an invoke function was provided.
    if (!invoke) throw corsErr;
    const proxied = (await invoke("fetch_mc_versions", { runtime })) as string[];
    versions = proxied.map((v) => ({ version: v, type: "release" as const }));
  }

  const seen = new Set<string>();
  return versions
    .filter((v) => {
      const dup = seen.has(v.version);
      seen.add(v.version);
      return !dup;
    })
    .sort((a, b) => {
      const aParts = a.version.split(".").map(Number);
      const bParts = b.version.split(".").map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const an = aParts[i] ?? 0;
        const bn = bParts[i] ?? 0;
        if (an !== bn) return bn - an;
      }
      return 0;
    });
}

/** Fetches Quilt versions. */
export async function fetchQuiltVersions(
  includeUnstable = false,
): Promise<{
  gameVersions: VersionInfo[];
  loaderVersions: string[];
  installerVersion: string | null;
}> {
  const res = await fetch("https://meta.quiltmc.org/v3/versions");
  const data: {
    game: Array<{ version: string; stable: boolean }>;
    loader: Array<{ version: string; stable: boolean }>;
    installer: Array<{ version: string; stable: boolean }>;
  } = await res.json();

  return {
    gameVersions: data.game
      .filter((v) => includeUnstable || v.stable)
      .map((v) => ({
        version: v.version,
        type: v.stable ? ("release" as const) : ("snapshot" as const),
      })),
    loaderVersions: data.loader
      .filter((v) => v.stable)
      .map((v) => v.version),
    installerVersion: data.installer.find((v) => v.stable)?.version ?? null,
  };
}
