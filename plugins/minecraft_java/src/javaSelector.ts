/**
 * javaSelector.ts — Java version mapping & detection integration.
 */

import type { JavaInstall } from "./types";

export type { JavaInstall };

/**
 * Maps a Minecraft version string to the recommended minimum
 * Java major version.
 *
 * Sources:
 *   https://minecraft.wiki/w/Java_Edition_1.20.5  (Java 21 requirement)
 *   https://minecraft.wiki/w/Java_Edition_1.17     (Java 16 minimum, 17 recommended)
 */
export function mcVersionToJavaVersion(mcVersion: string): number {
  if (!mcVersion) return 21; // safe default for unknown / latest

  const parts = mcVersion.split(".");
  const major = parseInt(parts[0] ?? "0", 10);
  const minor = parseInt(parts[1] ?? "0", 10);
  const patch = parseInt(parts[2] ?? "0", 10);

  // MC 26.1+ raised the Java requirement to 25. Earlier post-1.x releases
  // (and 26.0.x) still run on Java 21. A bare "26.1" (no patch segment) is
  // patch 0, so compare on minor alone: 26.1+ → 25.
  const atLeast26_1 = major > 26 || (major === 26 && minor >= 1);
  if (major > 1) return atLeast26_1 ? 25 : 21;

  // 1.21+ requires Java 21
  if (minor >= 21) return 21;

  // 1.20.5+ requires Java 21
  if (minor === 20 && patch >= 5) return 21;

  // 1.17 – 1.20.4 require Java 17
  if (minor >= 17) return 17;

  // 1.16 requires Java 11 (or 16 — 11 is the safe minimum)
  if (minor === 16) return 11;

  // Anything older (≤ 1.15) runs on Java 8
  return 8;
}

/**
 * Calls the Tauri `detect_java` command to find Java installations.
 *
 * @param invoke - The invoke function from hostAPI (avoids dynamic import).
 */
export async function detectJava(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<JavaInstall[]> {
  const results: JavaInstall[] = (await invoke("detect_java")) as JavaInstall[];
  return results;
}

/**
 * Filters Java installations that meet the version requirement for
 * a given MC version, sorted by preference (highest version first).
 */
export function filterJavaForMc(
  installs: JavaInstall[],
  mcVersion: string,
): JavaInstall[] {
  const required = mcVersionToJavaVersion(mcVersion);
  return installs
    .filter((j) => j.majorVersion >= required)
    .sort((a, b) => b.majorVersion - a.majorVersion || b.version.localeCompare(a.version));
}
