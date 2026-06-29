/**
 * main.ts — Plugin mount entry point.
 *
 * Exports `mount()` and `unmount()` as required by the Kern plugin system.
 *
 * The wizard: live MC version dropdown (fetched from API), snapshot toggle,
 * Java runtime detection, config display, auto-install with progress steps.
 */

import type { ServerInstance, HostAPI, JavaInstall, InstallStep } from "./types";
import type { VersionInfo } from "./versionFetcher";
import { fetchVersionsForRuntime } from "./versionFetcher";
import { detectJava, mcVersionToJavaVersion, filterJavaForMc } from "./javaSelector";
import { runInstall } from "./installer";
import { downloadJava } from "./downloadManager";

// ──────────────────────────────────────────────
//  State
// ──────────────────────────────────────────────

interface WizardState {
  serverData: ServerInstance;
  hostAPI: HostAPI;
  javaInstalls: JavaInstall[];
  selectedJava: string;
  mcVersion: string;
  mcVersions: VersionInfo[];
  fetchingVersions: boolean;
  includeSnapshots: boolean;
  installing: boolean;
  installSteps: InstallStep[];
  installLog: string[];
  installError: boolean;
  javaMajor: number;
  javaMissing: boolean;
  downloadingJava: boolean;
}

let state: WizardState | null = null;
let rootEl: HTMLElement | null = null;

// ──────────────────────────────────────────────
//  DOM helpers
// ──────────────────────────────────────────────

function $<T extends HTMLElement = HTMLDivElement>(
  tag: string,
  attrs: Record<string, string> = {},
  children: (string | HTMLElement)[] = [],
): T {
  const el = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) {
    // Skip undefined values — setAttribute("disabled", undefined) would set the
    // string "undefined" and permanently disable the element, since the mere
    // presence of a boolean attribute means "on" regardless of its value.
    if (v === undefined) continue;
    el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

function cls(...names: string[]): string {
  return names.filter(Boolean).join(" ");
}

declare global {
  interface Element {
    tap(fn: (el: this) => void): this;
  }
}

if (!Element.prototype.tap) {
  Element.prototype.tap = function <T extends Element>(this: T, fn: (el: T) => void): T {
    fn(this);
    return this;
  };
}

// ──────────────────────────────────────────────
//  Runtime-aware defaults
// ──────────────────────────────────────────────

/** Human-readable labels for each server runtime. */
const RUNTIME_LABELS: Record<string, string> = {
  vanilla: "Vanilla", paper: "Paper", purpur: "Purpur",
  fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt",
};

/**
 * Returns the recommended JVM arguments for a given server runtime.
 *
 * Heap size scales with expected mod load:
 *   - Vanilla / Paper / Purpur  → 2 GB  (lightweight)
 *   - Fabric / Quilt            → 3 GB  (moderate modding)
 *   - Forge / NeoForge          → 4 GB  (heavy modding)
 *
 * GC and optimisation flags are Aikar's community-standard set, proven to
 * reduce lag spikes and improve throughput on Minecraft servers.
 */
function getDefaultJvmArgs(runtime: string): string {
  const heap =
    runtime === "forge" || runtime === "neoforge" ? "4G" :
    runtime === "fabric" || runtime === "quilt" ? "3G" :
    "2G"; // vanilla, paper, purpur

  return [
    `-Xms${heap} -Xmx${heap}`,
    "-XX:+UseG1GC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    "-XX:G1NewSizePercent=30",
    "-XX:G1MaxNewSizePercent=40",
    "-XX:G1HeapRegionSize=8M",
    "-XX:G1ReservePercent=20",
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    "-XX:InitiatingHeapOccupancyPercent=15",
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:MaxTenuringThreshold=1",
  ].join(" ");
}

/**
 * Persists a single override key back to the server config via `update_server`.
 * Merges the new key into the existing user_overrides and writes the whole
 * instance record. Best-effort: a failed save shouldn't block the UI, but the
 * in-memory state is updated optimistically so the picker stays responsive.
 */
function persistOverride(
  hostAPI: HostAPI,
  serverData: ServerInstance,
  key: string,
  value: string,
): void {
  const overrides = { ...(serverData.userOverrides ?? {}), [key]: value };
  const payload: ServerInstance = {
    ...serverData,
    userOverrides: overrides,
  };
  void hostAPI
    .invoke("update_server", { server: payload })
    .catch((err) => console.warn(`[minecraft_java] failed to save ${key}:`, err));
}

/** Returns the heap size tier label for display. */
function heapTier(runtime: string): string {
  return runtime === "forge" || runtime === "neoforge" ? "heavy (4 GB)" :
         runtime === "fabric" || runtime === "quilt" ? "moderate (3 GB)" :
         "lightweight (2 GB)";
}

// ──────────────────────────────────────────────
//  Mount / Unmount
// ──────────────────────────────────────────────

export async function mount(
  mountPoint: HTMLElement,
  serverData: ServerInstance,
  hostAPI: HostAPI,
): Promise<void> {
  rootEl = mountPoint;

  const overrides = serverData.userOverrides ?? {};
  // Empty string = "auto-select latest from API after first fetch".
  // If the user has explicitly saved a version override, respect it.
  const mcVersion = overrides.mc_version || "";
  const runtime = overrides.runtime || "paper";

  let javaInstalls: JavaInstall[] = [];
  try {
    javaInstalls = await detectJava(hostAPI.invoke);
  } catch { /* non-fatal */ }

  let autoJava = overrides.java_path || "java";
  if (autoJava === "java" && javaInstalls.length > 0) {
    const filtered = filterJavaForMc(javaInstalls, mcVersion || "1.21");
    autoJava = filtered.length > 0 ? filtered[0].path : javaInstalls[0].path;
  }

  // The minimum Java major required for the (eventual) MC version. This
  // drives the "Install Java" prompt when no compatible JDK is detected.
  const javaMajor = mcVersionToJavaVersion(mcVersion || "1.21");
  const javaMissing =
    javaInstalls.length === 0 ||
    !javaInstalls.some((j) => j.majorVersion >= javaMajor);

  state = {
    serverData,
    hostAPI,
    javaInstalls,
    selectedJava: autoJava,
    mcVersion,
    mcVersions: [],
    fetchingVersions: true,
    includeSnapshots: false,
    installing: false,
    installSteps: [],
    installLog: [],
    installError: false,
    javaMajor,
    javaMissing,
    downloadingJava: false,
  };

  render();
  await fetchAndSetVersions(runtime, false);
}

export function unmount(): void {
  state = null;
  rootEl = null;
}

// ──────────────────────────────────────────────
//  Version fetching
// ──────────────────────────────────────────────

async function fetchAndSetVersions(runtime: string, includeSnapshots: boolean): Promise<void> {
  if (!state) return;
  state.fetchingVersions = true;
  state.mcVersions = [];
  render();

  try {
    const versions = await fetchVersionsForRuntime(runtime, includeSnapshots, state.hostAPI.invoke);
    if (!state) return;
    state.mcVersions = versions;
    state.fetchingVersions = false;

    if (versions.length > 0) {
      // If no user override was saved, auto-select the latest version.
      // If the saved version isn't in the fetched list, fall back to latest too.
      const shouldAutoSelect =
        !state.mcVersion ||
        !versions.find((v) => v.version === state.mcVersion);
      if (shouldAutoSelect) {
        state.mcVersion = versions[0].version;
      }
    }
  } catch {
    if (!state) return;
    state.mcVersions = [];
    state.fetchingVersions = false;
  }
  render();
}

// ──────────────────────────────────────────────
//  Render
// ──────────────────────────────────────────────

function render(): void {
  if (!rootEl || !state) return;
  rootEl.innerHTML = "";

  const wrapper = $("div", { class: "mc-wizard" }, [
    renderHeader(),
    renderVersionSelector(),
    renderConfigGrid(),
    renderJavaSection(),
    renderActionButtons(),
  ]);

  rootEl.appendChild(wrapper);
}

// ──────────────────────────────────────────────
//  Sections
// ──────────────────────────────────────────────

function renderHeader(): HTMLElement {
  return $("div", { class: "mc-header" }, [
    $("h2", { class: "mc-title" }, [`⛏ ${state!.serverData.name}`]),
    $("span", { class: "mc-subtitle" }, [
      `Server type: ${state!.serverData.serverType}`,
      `  ·  Path: ${state!.serverData.path}`,
    ]),
  ]);
}

function renderVersionSelector(): HTMLElement {
  const s = state!;
  const overrides = s.serverData.userOverrides ?? {};
  const runtime = overrides.runtime || "paper";

  const typeMap = RUNTIME_LABELS;

  const select = $<HTMLSelectElement>("select", {
    class: cls("mc-ver-select", s.fetchingVersions ? "mc-ver-loading" : ""),
    disabled: undefined,
  });

  if (s.fetchingVersions) {
    select.appendChild($<HTMLOptionElement>("option", { value: "" }, ["Loading versions…"]));
  } else if (s.mcVersions.length === 0) {
    select.appendChild($<HTMLOptionElement>("option", { value: "" }, [s.mcVersion || "No versions found"]));
  } else {
    for (const v of s.mcVersions) {
      const isCurrent = v.version === s.mcVersion;
      const suffix = v.type !== "release" ? ` (${v.type})` : "";
      const opt = $<HTMLOptionElement>("option", { value: v.version }, [`${v.version}${suffix}`]);
      if (isCurrent) opt.selected = true;
      select.appendChild(opt);
    }
    if (!select.value && s.mcVersions.length > 0) {
      select.value = s.mcVersions[0].version;
      if (state) state.mcVersion = s.mcVersions[0].version;
    }
  }

  select.addEventListener("change", () => {
    if (!state) return;
    state.mcVersion = select.value;
    render();
  });

  // Snapshot toggle
  const toggleId = "mc-snap-toggle";
  const toggle = $("label", { class: "mc-toggle", for: toggleId }, [
    $("input", { type: "checkbox", id: toggleId, class: "mc-toggle-input" }).tap((cb) => {
      cb.checked = s.includeSnapshots;
      cb.addEventListener("change", async () => {
        if (!state) return;
        state.includeSnapshots = cb.checked;
        await fetchAndSetVersions(runtime, cb.checked);
      });
    }),
    $("span", { class: "mc-toggle-track" }, [
      $("span", { class: "mc-toggle-knob" }),
    ]),
    $("span", { class: "mc-toggle-label" }, [
      s.includeSnapshots ? "Snapshots ON" : "Snapshots OFF",
    ]),
  ]);

  const refreshBtn = $<HTMLButtonElement>("button", {
    class: cls("mc-btn", "mc-btn-sm", s.fetchingVersions ? "mc-btn-disabled" : ""),
    type: "button",
    disabled: s.fetchingVersions ? "true" : undefined,
  }, ["↻"]);
  refreshBtn.addEventListener("click", async () => {
    if (!state || state.fetchingVersions) return;
    await fetchAndSetVersions(runtime, state.includeSnapshots);
  });

  return $("div", { class: "mc-section" }, [
    $("div", { class: "mc-section-title" }, ["Version Selection"]),
    $("div", { class: "mc-ver-row" }, [
      $("span", { class: "mc-ver-badge" }, [typeMap[runtime] || runtime]),
      s.fetchingVersions
        ? $("span", { class: "mc-ver-spinner" }, ["⟳"])
        : $("span", { style: "display:none" }),
      select,
      toggle,
      refreshBtn,
    ]),
    $("span", { class: "mc-ver-hint" }, [
      s.fetchingVersions
        ? "Fetching available versions…"
        : s.mcVersions.length > 0
          ? `${s.mcVersions.length} version(s) available`
          : "Could not fetch versions. Check your internet connection.",
    ]),
  ]);
}

function renderConfigGrid(): HTMLElement {
  const s = state!;
  const overrides = s.serverData.userOverrides ?? {};
  const runtime = overrides.runtime || "paper";
  const runtimeLabel = RUNTIME_LABELS[runtime] || runtime;
  const recommendedJvm = getDefaultJvmArgs(runtime);
  const currentJvm = overrides.jvm_args || recommendedJvm;
  const usingRecommended = currentJvm === recommendedJvm;

  return $("div", { class: "mc-section" }, [
    $("div", { class: "mc-section-title" }, ["Configuration"]),
    $("div", { class: "mc-config-grid" }, [
      $("div", { class: "mc-config-item" }, [
        $("span", { class: "mc-config-label" }, ["Server Port"]),
        $("span", { class: "mc-config-value" }, [overrides.server_port || "25565"]),
      ]),
      $("div", { class: "mc-config-item mc-config-jvm" }, [
        $("span", { class: "mc-config-label" }, [
          "JVM Args",
          $("span", { class: "mc-config-badge" }, [`${heapTier(runtime)} · ${runtimeLabel}`]),
        ]),
        $("code", { class: cls("mc-config-value", "mc-jvm-flags", usingRecommended ? "" : "mc-jvm-custom") }, [currentJvm]),
      ]),
    ]),
  ]);
}

function renderJavaSection(): HTMLElement {
  const s = state!;
  const recommended = mcVersionToJavaVersion(s.mcVersion);

  const options = s.javaInstalls.map((j) => {
    const isRec = j.majorVersion >= recommended;
    return {
      value: j.path,
      label: `Java ${j.majorVersion} (${j.version})${isRec ? " ✓" : ""} — ${j.path}`,
      selected: j.path === s.selectedJava,
    };
  });

  if (!options.find((o) => o.value === "java")) {
    options.unshift({
      value: "java",
      label: "java (on PATH)",
      selected: s.selectedJava === "java",
    });
  }

  const select = $<HTMLSelectElement>("select", { class: "mc-java-select" });
  for (const opt of options) {
    const el = $<HTMLOptionElement>("option", { value: opt.value }, [opt.label]);
    if (opt.selected) el.selected = true;
    select.appendChild(el);
  }
  select.addEventListener("change", () => {
    if (!state) return;
    state.selectedJava = select.value;
    // Persist java_path so the launch command uses the selected JDK instead of
    // the stale override (which otherwise keeps pointing at the old version).
    persistOverride(state.hostAPI, state.serverData, "java_path", select.value);
  });

  // "Install Java" prompt — shown when no detected JDK satisfies the required
  // major for the selected MC version. Offers a one-click Temurin download.
  const installBtn = $<HTMLButtonElement>("button", {
    class: cls("mc-btn", "mc-btn-sm", s.downloadingJava ? "mc-btn-disabled" : "mc-btn-primary"),
    type: "button",
    disabled: s.downloadingJava ? "true" : undefined,
  }, [s.downloadingJava ? "downloading…" : `install Java ${s.javaMajor}`]);

  installBtn.addEventListener("click", () => {
    if (!state || state.downloadingJava) return;
    state.downloadingJava = true;
    render();

    const destDir = `${state.hostAPI.serverPath}/jdk`;
    downloadJava(state.javaMajor, destDir, state.hostAPI.invoke, {
      onComplete(installed) {
        if (!state) return;
        state.downloadingJava = false;
        // The sandbox JDK isn't in a standard install dir, so the system scanner
        // won't find it — use the path download_java discovered directly, and
        // fold it into the installs list so it shows in the dropdown.
        const fresh: JavaInstall = installed
          ? {
              path: installed.path,
              version: installed.version,
              majorVersion: installed.majorVersion,
            }
          : {
              // Fallback only: guess the layout if the return value was empty.
              path: `${destDir}/bin/java`,
              version: `${state.javaMajor}.0.0`,
              majorVersion: state.javaMajor,
            };
        // Re-detect to pick up any *other* JDKs, then merge the sandbox one in.
        detectJava(state.hostAPI.invoke)
          .then((detected) => {
            if (!state) return;
            const merged = [fresh];
            for (const j of detected) {
              if (!merged.some((m) => m.path === j.path)) merged.push(j);
            }
            state.javaInstalls = merged;
            state.javaMissing = false;
            state.selectedJava = fresh.path;
            // Persist the sandbox JDK path so launch uses it.
            persistOverride(state.hostAPI, state.serverData, "java_path", fresh.path);
            render();
          })
          .catch(() => {
            if (!state) return;
            state.javaInstalls = [fresh];
            state.javaMissing = false;
            state.selectedJava = fresh.path;
            render();
          });
      },
      onError(err) {
        if (!state) return;
        state.downloadingJava = false;
        state.installLog.push(`❌  Java install failed: ${err}`);
        render();
      },
    });
  });

  // Show the install prompt only when the required Java major is missing AND
  // we're not already downloading it.
  const installPrompt: HTMLElement | null =
    s.javaMissing && !s.downloadingJava
      ? $("div", { class: "mc-java-missing" }, [
          $("span", { class: "mc-java-warn" }, [
            `⚠ No Java ${s.javaMajor}+ found — required for MC ${s.mcVersion || "selected"}. `,
          ]),
          installBtn,
        ])
      : null;

  const downloadingHint: HTMLElement | null =
    s.downloadingJava
      ? $("div", { class: "mc-java-downloading" }, [
          installBtn,
          $("span", { class: "mc-java-hint" }, [
            `Downloading + extracting Java ${s.javaMajor} into jdk/ …`,
          ]),
        ])
      : null;

  return $("div", { class: "mc-section" }, [
    $("div", { class: "mc-section-title" }, [`Java Runtime  —  recommended: Java ${recommended}`]),
    $("div", { class: "mc-java-row" }, [
      select,
      $("button", { class: "mc-btn mc-btn-sm", type: "button" }, ["↻"]).tap((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const installs = await detectJava(state.hostAPI.invoke);
            if (!state) return;
            state.javaInstalls = installs;
            state.javaMissing = !installs.some((j) => j.majorVersion >= state.javaMajor);
            render();
          } catch { /* ignore */ }
        });
      }),
      $("input", {
        class: "mc-java-path-input",
        type: "text",
        placeholder: "Or type a Java path…",
        value: s.selectedJava,
      }).tap((input) => {
        input.addEventListener("input", () => {
          if (state) state.selectedJava = input.value;
        });
      }),
    ]),
    installPrompt ?? $("span", { style: "display:none" }),
    downloadingHint ?? $("span", { style: "display:none" }),
    javaInstallsSummary(s.javaInstalls, s.mcVersion),
  ]);
}

function javaInstallsSummary(installs: JavaInstall[], mcVersion: string): HTMLElement {
  const recommended = mcVersionToJavaVersion(mcVersion);
  const filtered = filterJavaForMc(installs, mcVersion);

  if (installs.length === 0) {
    return $("p", { class: "mc-java-warn" }, ["⚠ No Java installations detected. Type a path manually."]);
  }

  return $("p", { class: "mc-java-info" }, [
    `Found ${installs.length} Java installation(s), ` +
    `${filtered.length} compatible with MC ${mcVersion} (Java ${recommended}+).`,
  ]);
}

// ---------------------------------------------------------------------------
//  Install orchestration
//
//  The multi-step download + installer flow (Fabric/Forge/Quilt installers,
//  server.jar downloads, eula.txt + server.properties writes) can't be expressed
//  as a single host-header lifecycle step, so it lives here in the plugin panel,
//  driven by installer.ts.
// ---------------------------------------------------------------------------

/** Status dot color per step state. */
function stepDot(status: InstallStep["status"]): string {
  switch (status) {
    case "running":
      return "signal-high";
    case "done":
      return "text-zinc-500";
    case "error":
      return "fault-vector";
    default:
      return "text-zinc-700";
  }
}

function renderActionButtons(): HTMLElement {
  const s = state!;
  const runtime = (s.serverData.userOverrides ?? {}).runtime || "paper";
  const canInstall = !s.fetchingVersions && s.mcVersion !== "" && !s.installing;

  const btn = $<HTMLButtonElement>("button", {
    class: cls(
      "mc-btn",
      canInstall ? "" : "mc-btn-disabled",
    ),
    type: "button",
    disabled: canInstall ? undefined : "true",
  }, [
    s.installing
      ? s.installError
        ? "retry install"
        : "installing…"
      : s.installSteps.some((st) => st.status === "done")
        ? "re-install"
        : "install",
  ]);

  btn.addEventListener("click", () => {
    if (!state || !canInstall) return;
    state.installing = true;
    state.installSteps = [];
    state.installLog = [];
    state.installError = false;
    render();

    runInstall(state.serverData.id, runtime, state.mcVersion, state.selectedJava, state.hostAPI, {
      onStepUpdate(steps) {
        if (!state) return;
        state.installSteps = steps;
        render();
      },
      onLog(line) {
        if (!state) return;
        state.installLog.push(line);
        // Keep the log tail bounded so a long install doesn't grow without limit.
        if (state.installLog.length > 200) {
          state.installLog = state.installLog.slice(-200);
        }
        render();
      },
      onComplete(success, message) {
        if (!state) return;
        state.installing = false;
        state.installError = !success;
        state.installLog.push(
          success ? `✅  ${message}` : `❌  ${message}`,
        );
        render();
      },
    }).catch((err: unknown) => {
      // Surfaced here so a thrown error (e.g. a failed invoke) shows in the
      // panel log tail instead of silently becoming an unhandled rejection.
      if (!state) return;
      state.installing = false;
      state.installError = true;
      state.installLog.push(`❌  ${err}`);
      render();
    });
  });

  // Step-progress list — only shown once an install has started.
  const stepList: HTMLElement | null =
    s.installSteps.length > 0
      ? $("div", { class: "mc-install-steps" },
          s.installSteps.map((st) => {
            const message = st.message ? ` — ${st.message}` : "";
            return $("div", { class: `mc-install-step text-zinc-400` }, [
              $("span", { class: `mc-install-dot ${stepDot(st.status)}` }, ["●"]),
              $("span", { class: "mc-install-label" }, [`${st.label}${message}`]),
            ]);
          }),
        )
      : null;

  // Live log tail — last few lines of installer output.
  const logTail: HTMLElement | null =
    s.installLog.length > 0
      ? $("div", { class: "mc-install-log" },
          s.installLog.slice(-6).map((line) =>
            $("div", { class: "mc-install-log-line" }, [line]),
          ),
        )
      : null;

  return $("div", { class: "mc-section" }, [
    $("div", { class: "mc-section-title" }, ["Installation"]),
    $("div", { class: "mc-install-row" }, [btn, s.installing
      ? $("span", { class: "mc-install-spinner" }, ["⟳ working…"])
      : $("span", { class: "mc-install-hint" }, [
          s.mcVersion
            ? `Downloads + configures ${runtime} ${s.mcVersion}`
            : "Select a Minecraft version to install",
        ]),
    ]),
    stepList ?? $("span", { style: "display:none" }),
    logTail ?? $("span", { style: "display:none" }),
  ]);
}

