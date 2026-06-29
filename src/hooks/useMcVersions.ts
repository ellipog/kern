import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * useMcVersions.ts — Live Minecraft & Java version data for the setup form.
 *
 * Fetches version lists DIRECTLY from the platform APIs via `fetch()` so it
 * works instantly on a frontend rebuild (no Rust/`tauri dev` restart needed).
 * For runtimes whose APIs send no CORS headers (Forge), it transparently
 * falls back to the Rust `fetch_mc_versions` proxy which runs the same HTTP
 * server-side.
 */

export type McRuntime =
  | "vanilla" | "paper" | "purpur"
  | "fabric" | "forge" | "neoforge" | "quilt";

/** Human labels for the runtime dropdown. */
export const RUNTIME_LABELS: Record<string, string> = {
  vanilla: "Vanilla", paper: "Paper", purpur: "Purpur",
  fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt",
};

/**
 * Fetches available Minecraft version strings for a given server runtime.
 *
 * Tries a direct browser `fetch()` first (instant, no `tauri dev` restart
 * needed). If that fails — chiefly for Forge, whose promotions API sends no
 * CORS headers — it falls back to the Rust `fetch_mc_versions` proxy command
 * which runs the same HTTP server-side.
 *
 * Defaults to "vanilla" when no runtime is given so the dropdown populates
 * immediately on form load, before the user picks a server software.
 */
export function useMcVersions(runtime?: string) {
  const rt = (runtime as McRuntime) || "vanilla";
  const [versions, setVersions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // 1. Try direct browser fetch first (fast, no Rust dependency).
        let list: string[] = [];
        try {
          list = await fetchVersionsForRuntime(rt);
        } catch (directErr) {
          // 2. CORS / network failure — fall back to the Rust proxy.
          list = await invoke<string[]>("fetch_mc_versions", { runtime: rt });
          if (!list.length) throw directErr;
        }
        if (!cancelled && mountedRef.current) {
          setVersions(list);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setVersions([]);
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [rt]);

  return { versions, loading, error };
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Sorts "1.20.4"-style version strings newest-first. */
function sortNewestFirst(versions: string[]): string[] {
  const partsOf = (v: string): number[] =>
    v.split(".").map((p) => parseInt(p, 10) || 0);
  return [...versions].sort((a, b) => {
    const ap = partsOf(a);
    const bp = partsOf(b);
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      const an = ap[i] ?? 0;
      const bn = bp[i] ?? 0;
      if (an !== bn) return bn - an;
    }
    return 0;
  });
}

/** Dedupe + sort a raw version list. */
function tidy(versions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of versions) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return sortNewestFirst(out);
}

async function fetchVersionsForRuntime(runtime: McRuntime): Promise<string[]> {
  switch (runtime) {
    case "vanilla": {
      const data = await fetchJson(
        "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
      );
      return tidy(
        (data.versions ?? [])
          .filter((v: any) => v.type === "release")
          .map((v: any) => v.id as string),
      );
    }
    case "paper": {
      const data = await fetchJson("https://api.papermc.io/v2/projects/paper");
      return tidy((data.versions ?? []).filter((v: string) => /^\d+\.\d+/.test(v)));
    }
    case "purpur": {
      // Purpur v2 API returns { versions: ["1.20.1", ...] } directly.
      const data = await fetchJson("https://api.purpurmc.org/v2/purpur");
      return tidy((data.versions ?? []).filter((v: string) => /^\d+\.\d+/.test(v)));
    }
    case "fabric": {
      const data = await fetchJson("https://meta.fabricmc.net/v2/versions");
      return tidy(
        (data.game ?? [])
          .filter((v: any) => v.stable)
          .map((v: any) => v.version as string),
      );
    }
    case "forge": {
      // Forge's promotions API sends NO CORS headers — this browser fetch
      // will be rejected by the browser. The hook catches the error and
      // transparently falls back to the Rust `fetch_mc_versions` proxy.
      const data = await fetchJson(
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
      );
      const promos: Record<string, string> = data.promos ?? {};
      const mcVersions = new Set<string>();
      for (const key of Object.keys(promos)) {
        const dash = key.lastIndexOf("-");
        if (dash === -1) continue;
        const suffix = key.slice(dash + 1);
        if (suffix === "recommended" || suffix === "latest") {
          mcVersions.add(key.slice(0, dash));
        }
      }
      return tidy([...mcVersions]);
    }
    case "neoforge": {
      // NeoForge's old meta API (api.neoforged.net) is dead. The Maven
      // versions endpoint lists build names like "20.2.3-beta" or
      // "26.1.2.71" — the first two numeric segments encode the MC version
      // (20.2 → 1.20.2, 26.1 → 26.1).
      const data = await fetchJson(
        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
      );
      const seen = new Set<string>();
      for (const build of data.versions ?? []) {
        const m = String(build).match(/^(\d+)\.(\d+)/);
        if (!m) continue;
        const major = parseInt(m[1], 10);
        const minor = parseInt(m[2], 10);
        // Pre-2025 naming: 20.x → 1.20.x. 2026+ keeps the MC version as-is.
        const mc = major >= 21 ? `${major}.${minor}` : `1.${major}.${minor}`;
        seen.add(mc);
      }
      return tidy([...seen]);
    }
    case "quilt": {
      const data = await fetchJson("https://meta.quiltmc.org/v3/versions");
      return tidy(
        (data.game ?? [])
          .filter((v: any) => v.stable)
          .map((v: any) => v.version as string),
      );
    }
    default:
      return [];
  }
}

/** Java installation shape returned by the `detect_java` command. */
interface JavaInstall {
  path: string;
  version: string;
  majorVersion: number;
}

/**
 * Detects Java installations on the host via the `detect_java` Rust command.
 * Returns the unique set of major Java versions available (sorted descending).
 *
 * `detect_java` is a pre-existing command (no Rust rebuild needed) — it ships
 * with the app. If it fails we silently fall back to a curated list.
 */
export function useDetectedJavaMajors() {
  const [majors, setMajors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const installs = await invoke<JavaInstall[]>("detect_java");
        if (cancelled || !mountedRef.current) return;
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const j of installs) {
          const key = String(j.majorVersion);
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(key);
          }
        }
        unique.sort((a, b) => Number(b) - Number(a));
        setMajors(unique);
      } catch {
        if (!cancelled && mountedRef.current) setMajors([]);
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  return { majors, loading };
}

/**
 * Maps a Minecraft version to the recommended minimum Java major version.
 * Mirrors the plugin's javaSelector logic.
 */
export function mcVersionToJavaMajor(mcVersion: string): string {
  if (!mcVersion) return "21";
  const parts = mcVersion.split(".");
  const major = parseInt(parts[0] ?? "0", 10);
  const minor = parseInt(parts[1] ?? "0", 10);
  const patch = parseInt(parts[2] ?? "0", 10);
  if (major > 1) {
    // MC 26.1+ raised the Java requirement to 25. Earlier post-1.x releases
    // (and 26.0.x) still run on Java 21. A bare "26.1" (no patch segment) is
    // patch 0, so compare on minor alone when patch is absent: 26.1+ → 25.
    const atLeast26_1 = major > 26 || (major === 26 && minor >= 1);
    return atLeast26_1 ? "25" : "21";
  }
  if (minor >= 21) return "21";
  if (minor === 20 && patch >= 5) return "21";
  if (minor >= 17) return "17";
  if (minor === 16) return "11";
  return "8";
}
