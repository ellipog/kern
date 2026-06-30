import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ServerInstance } from "../../types/server";
import { useServerControl } from "../../hooks/useServerControl";
import { usePlugins } from "../../hooks/usePlugins";
import { useMetrics } from "../../hooks/useMetrics";
import { useLogActivity } from "../../hooks/useLogActivity";
import { useUiState } from "../../hooks/useUiState";
import { statusHex } from "./status";
import {
  parseAnsi,
  DEFAULT_FG,
  TS_COLOR,
  classifyLevelColor,
  parseTimestamp,
} from "./ansi";
import { PluginBoot, preloadPluginAssets } from "../plugins/PluginBoot";
import { PluginTabContent } from "../plugins/PluginTabContent";
import { MatrixBar } from "../matrix/MatrixBar";
import { reactorChannelShader } from "../matrix/shaders/reactorChannel";
import { FileEditorPanel } from "./FileEditorPanel";
import {
  PluginTabRegistryProvider,
  usePluginTabs,
} from "../../hooks/usePluginTabs";
import {
  ToolbarActionRegistryProvider,
  useToolbarActions,
} from "../../hooks/useToolbarActions";
import type { PluginTab, HostAPI } from "../../types/plugin";

/** Built-in tab definitions. The id "logs" is kept for persisted-state compat. */
const BUILT_IN_TABS = [
  { id: "logs", label: "terminal" },
  { id: "files", label: "files" },
] as const;

interface ServerDetailViewProps {
  server: ServerInstance;
  onBack: () => void;
  /** Called after lifecycle actions so the parent can refresh registry state. */
  onStatusChange: () => void;
}

/**
 * Single-instance control surface: metadata header, lifecycle controls
 * (start/stop/restart/install), plugin panel, and a live-streaming log terminal.
 *
 * Phase 4: Added Install (when plugin declares it) and Restart (while running)
 * buttons alongside the existing Start/Stop. The install step is typically a
 * one-shot command (npm install, cargo build) that exits on its own.
 *
 * The terminal auto-scrolls to the bottom as new lines stream in, unless the
 * user has scrolled up to read history (then it stays put).
 */
export function ServerDetailView({
  server,
  onBack,
  onStatusChange,
}: ServerDetailViewProps) {
  const { logs, running, launching, busy, launch, stop, install, restart, error, pushLine } =
    useServerControl(server.id, onStatusChange);
  const { byId } = usePlugins();
  // Live process-tree telemetry drives the header reactor bar. When the instance
  // isn't running the backend returns a zeroed reading, so the bar idles cleanly.
  const metrics = useMetrics(server.id);
  // Log churn feeds the bar's activity lane so output bursts visibly flare.
  const activity = useLogActivity(server.id);
  const { uiState, updateServer } = useUiState();
  const terminalRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const inputHistoryRef = useRef<string[]>([]);

  // ── Persisted per-server UI state ──────────────────────────────────────
  // Read the saved state for this server (falls back to defaults when none).
  const serverUi = uiState.servers[server.id] ?? {
    activeTab: "logs" as const,
    commandHistory: [],
    editor: { openFiles: [], activeFile: null, expandedPaths: [], cursorLine: 1, cursorCol: 1 },
  };

  const [activeTab, setActiveTabState] = useState<string>("logs");

  // Wrap the setter to also persist the change.
  const setActiveTab = useCallback(
    (tab: string) => {
      setActiveTabState(tab);
      updateServer(server.id, { activeTab: tab });
    },
    [server.id, updateServer],
  );

  // Restore command history from persisted state on mount.
  useEffect(() => {
    if (serverUi.commandHistory.length > 0) {
      inputHistoryRef.current = [...serverUi.commandHistory];
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute whether the "scroll to bottom" button should be visible. The
  // button shows when the terminal's content overflows AND the user is parked
  // above the bottom. Single source of truth, called from scroll events and
  // from every effect that can change the content height or scroll position.
  const refreshScrollButton = useCallback(() => {
    const el = terminalRef.current;
    if (!el) return;
    const overflows = el.scrollHeight > el.clientHeight + 1;
    if (!overflows) {
      setShowScrollButton(false);
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setShowScrollButton(!atBottom);
  }, []);

  // Does this server's plugin declare an "install" lifecycle step?
  const pluginManifest = useMemo(() => byId(server.serverType), [byId, server.serverType]);
  const hasInstallStep = useMemo(
    () => pluginManifest?.lifecycle?.install != null,
    [pluginManifest],
  );

  // Kick off background preloading of plugin assets as soon as we know the
  // plugin type. This starts the IPC call, CSS fetch, and JS module import
  // before PluginBoot mounts, so its boot sequence is near-instant.
  useEffect(() => {
    if (pluginManifest) preloadPluginAssets(server.serverType);
  }, [pluginManifest, server.serverType]);

  // Track whether the install lifecycle step has been run at least once.
  // Persisted via a .installed marker file in the instance directory.
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("server_file_exists", { id: server.id, relPath: ".installed" })
      .then((exists) => { if (!cancelled) setInstalled(exists); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [server.id]);

  /** After a successful install, write the .installed marker. */
  const handleInstalled = useCallback(async () => {
    try {
      await invoke("write_server_file", { id: server.id, relPath: ".installed", content: "" });
      setInstalled(true);
    } catch { /* non-fatal */ }
  }, [server.id]);

  // Submit the current input line. The console is always active — it doubles
  // as a command dispatcher for lifecycle actions (start/stop/restart/install)
  // when the process isn't running, and pipes raw stdin to the process when it
  // is. Unknown commands while running are sent straight to the process.
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) return;
      // Echo locally so the user sees what they typed.
      pushLine(`> ${trimmed}`);
      // Dispatch known lifecycle keywords regardless of running state.
      const cmd = trimmed.toLowerCase();
      if (cmd === "start") {
        await launch();
      } else if (cmd === "stop") {
        await stop();
      } else if (cmd === "restart") {
        await restart();
      } else if (cmd === "install") {
        await install();
        await handleInstalled();
      } else {
        // Not a lifecycle keyword — pipe to the running process's stdin.
        if (running) {
          void invoke("write_stdin_to_instance", {
            id: server.id,
            data: trimmed + "\n",
          });
        } else {
          pushLine("  (no running process — use 'start' to launch)");
        }
      }
      inputHistoryRef.current.push(trimmed);
      // Persist the updated command history (capped to last 50 entries).
      const capped = inputHistoryRef.current.slice(-50);
      updateServer(server.id, { commandHistory: capped });
      setHistoryIndex(-1);
      setInput("");
    },
    [input, running, server.id, pushLine, launch, stop, restart, install, handleInstalled, updateServer],
  );

  // Up/Down arrows cycle through local command history.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const hist = inputHistoryRef.current;
      if (hist.length === 0) return;
      const next = Math.min(historyIndex + 1, hist.length - 1);
      setHistoryIndex(next);
      setInput(hist[hist.length - 1 - next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput("");
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(inputHistoryRef.current[inputHistoryRef.current.length - 1 - next]);
    }
  }

  // Focus the input box when the detail view mounts or the terminal becomes active.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Track whether the user is parked at the bottom of the log. When they
  // scroll up away from the bottom, surface the "scroll to bottom" button.
  // Uses a 40px threshold so the button appears as soon as the user has
  // scrolled up meaningfully, rather than requiring pixel-perfect bottoming.
  function handleScroll() {
    const el = terminalRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottomRef.current = atBottom;
    refreshScrollButton();
  }

  // Snap back to the bottom and re-lock auto-scroll. Used by the floating
  // "scroll to bottom" button.
  function scrollToBottom() {
    stickToBottomRef.current = true;
    snapToBottom();
    refreshScrollButton();
  }

  // Snap the viewport to the very bottom of the terminal. Deferred to a
  // requestAnimationFrame so the browser has laid out the latest content
  // (new lines, resized viewport) before we read scrollHeight — without this
  // the scroll can race the layout pass and land one frame short, leaving the
  // latest line just above the fold so the stream looks "not live".
  const snapToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = terminalRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Stick to bottom on new lines, unless the user scrolled up. After snapping,
  // re-evaluate the scroll button so it hides when we're locked to the bottom.
  useEffect(() => {
    if (stickToBottomRef.current) snapToBottom();
    refreshScrollButton();
  }, [logs, snapToBottom, refreshScrollButton]);

  // Also stick to bottom when the terminal resizes (input box appearing,
  // window resize, plugin panel loading, etc.) — without this the viewport
  // can get shorter and leave the latest lines hidden above the fold.
  // Re-evaluates the button after each resize, since the content may now
  // overflow (or stop overflowing) while the user is parked above bottom.
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) snapToBottom();
      refreshScrollButton();
    });
    ro.observe(el);
    refreshScrollButton();
    return () => ro.disconnect();
  }, [snapToBottom, refreshScrollButton]);

  // Force scroll to the very bottom whenever the user submits a command
  // (echo line via pushLine) or the process starts/stops — ensures the
  // latest output is always visible even when the content height doesn't
  // change enough to trigger the effects above.
  useEffect(() => {
    if (stickToBottomRef.current) snapToBottom();
    refreshScrollButton();
  }, [running, logs.length, snapToBottom, refreshScrollButton]);

  // Always scroll to the bottom on initial mount — the seeded log tail loads
  // asynchronously and the layout may not be settled when the component first
  // renders, so we force it regardless of the current scroll state. The
  // user can still scroll up afterward to unlock. The seeded tail pops in a
  // tick after mount, so poll for a short window to (a) snap to the real
  // bottom once it lands and (b) surface the button once content overflows.
  useEffect(() => {
    snapToBottom();
    refreshScrollButton();
    let tries = 0;
    const timer = setInterval(() => {
      snapToBottom();
      refreshScrollButton();
      if (++tries >= 10) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [snapToBottom, refreshScrollButton]);

  // Live status: prefer the streaming `running` flag, fall back to persisted.
  const liveStatus = running
    ? "running"
    : launching
      ? "starting"
      : busy
        ? "installing"
        : server.isOrphaned
          ? "orphaned"
          : server.status;
  const liveColor = server.isOrphaned
    ? "crimson"
    : running
      ? "green"
      : busy || launching
        ? "amber"
        : "gray";
  const liveHex = statusHex(liveColor);

  // Disable lifecycle buttons while any transient operation is in flight.
  const transitioning = launching || busy;

  // Use both the live process state (`running`) AND the parent's status
  // overlay (`server.status`) so the correct set of action buttons
  // (Restart/Stop vs Reinstall/Start) appears immediately on remount,
  // without waiting for the async is_server_running seed to resolve.
  // Orphaned instances never get running-state buttons — their persisted
  // status may be stale since the live overlay is skipped for them.
  const isEffectivelyRunning = !server.isOrphaned && (running || server.status === "running");

  return (
    <PluginTabRegistryProvider>
      <ToolbarActionRegistryProvider>
      <div className="flex flex-col h-full">
        {/* Header / metadata */}
        <div className="border-b border-grid-bounds p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={onBack}
                className="text-[18px] text-zinc-500 hover:text-zinc-200 transition-colors mr-1"
              >
                ←
              </button>
              <div className="min-w-0">
                <h2 className="text-sm text-zinc-100 truncate">{server.name}</h2>
                <p className="text-[11px] text-zinc-500 font-mono truncate">
                  {server.id} · {server.serverType}
                </p>
              </div>
            </div>

            {/* Reactor channel — a fluid-width matrix strip filling the space
                between the instance name and the lifecycle buttons. Layers CPU
                shimmer, RAM fill, and log-activity comet pulses into one bar. */}
            <div className="flex-1 min-w-0 flex flex-col gap-1 px-2">
              <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-zinc-600 tabular-nums">
                <span className="flex items-center gap-3">
                  <span>
                    cpu{" "}
                    <span className={metrics.cpu > 0.9 ? "text-fault-vector" : "text-zinc-400"}>
                      {(metrics.cpu * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span>
                    ram{" "}
                    <span className={metrics.ram > 0.85 ? "text-fault-vector" : "text-zinc-400"}>
                      {(metrics.ram * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span>
                    log{" "}
                    <span className={activity > 1 ? "text-signal-high" : "text-zinc-400"}>
                      {activity.toFixed(1)}×
                    </span>
                  </span>
                </span>
                <span className="opacity-60">reactor</span>
              </div>
              <MatrixBar
                shader={reactorChannelShader}
                telemetry={{ ...metrics, status: liveStatus, activity }}
                rows={2}
                pitchPx={6}
              />
            </div>

          <HeaderToolbar
            liveHex={liveHex}
            liveStatus={liveStatus}
            isEffectivelyRunning={isEffectivelyRunning}
            transitioning={transitioning}
            hasInstallStep={hasInstallStep}
            installed={installed}
            busy={busy}
            launching={launching}
            server={server}
            restart={restart}
            stop={stop}
            install={install}
            handleInstalled={handleInstalled}
            launch={launch}
          />
          </div>

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
            <dt className="text-zinc-600 uppercase tracking-wider">path</dt>
            <dd className="text-zinc-400 font-mono truncate flex items-center gap-2" title={server.path}>
              <span className="truncate">{server.path}</span>
              <button
                onClick={() => void invoke("open_folder", { path: server.path })}
                className="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-200 border border-grid-bounds hover:border-signal-low px-1.5 py-0.5 transition-colors"
                title="Open folder in file manager"
              >
                [open]
              </button>
            </dd>
            {Object.keys(server.userOverrides).length > 0 && (
              <>
                <dt className="text-zinc-600 uppercase tracking-wider">overrides</dt>
                <dd className="text-zinc-400 font-mono truncate">
                  {Object.entries(server.userOverrides)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" ")}
                </dd>
              </>
            )}
          </dl>
        </div>

        {error && (
          <p className="m-4 text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1">
            {error}
          </p>
        )}

        {server.isOrphaned && (
          <p className="m-4 text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1">
            [orphaned] path inaccessible — instance marked orphaned. Cannot launch
            until the folder is restored.
          </p>
        )}

      {/* Plugin boot loader — invisible, mounts the plugin so it can register
          tabs, toolbar actions, sidebar items, etc. through the HostAPI. */}
      {pluginManifest && (
        <PluginBoot
          pluginId={server.serverType}
          serverData={server}
        />
      )}

      {/* Tab bar + content — uses PluginTabRegistry context for plugin tabs */}
      <TabSection
          server={server}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          logs={logs}
          terminalRef={terminalRef}
          handleScroll={handleScroll}
          showScrollButton={showScrollButton}
          scrollToBottom={scrollToBottom}
          input={input}
          setInput={setInput}
          inputRef={inputRef}
          handleKeyDown={handleKeyDown}
          handleSubmit={handleSubmit}
        />
      </div>
      </ToolbarActionRegistryProvider>
    </PluginTabRegistryProvider>
  );
}

/* ─── Tab Section (reads plugin tabs from context) ────────────────────── */

interface TabSectionProps {
  server: ServerInstance;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  logs: string[];
  terminalRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  showScrollButton: boolean;
  scrollToBottom: () => void;
  input: string;
  setInput: (val: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleSubmit: (e?: React.FormEvent) => Promise<void>;
}

/**
 * Tab bar + content area. Uses usePluginTabs() to read plugin-registered tabs
 * so they appear alongside the built-in "terminal" (logs) and "files" tabs.
 */
function TabSection({
  server,
  activeTab,
  setActiveTab,
  logs,
  terminalRef,
  handleScroll,
  showScrollButton,
  scrollToBottom,
  input,
  setInput,
  inputRef,
  handleKeyDown,
  handleSubmit,
}: TabSectionProps) {
  const { tabs: pluginTabs, getTab } = usePluginTabs();

  // Build a combined tab list: built-in first, then plugin tabs.
  const allTabs = useMemo(() => {
    const builtIn = BUILT_IN_TABS.map((t) => ({
      id: t.id,
      label: t.label,
      isPlugin: false,
    }));
    const plugin = pluginTabs.map((t) => ({
      id: t.id,
      label: t.label,
      isPlugin: true,
    }));
    return [...builtIn, ...plugin];
  }, [pluginTabs]);

  // Generate a fresh hostAPI for plugin tab content.
  const hostAPI = useMemo<HostAPI>(
    () => ({
      invoke: (cmd, args) => invoke(cmd, args),
      serverPath: server.path,
      listen: (event, handler) =>
        listen(event, (e) => handler(e.payload)),
      // register/unregister methods are no-ops inside tab content
      // (extensions should be registered from the plugin's main mount, not
      // from within a tab's own mount, to prevent circular registration).
      registerTab: () => {},
      unregisterTab: () => {},
      registerToolbarAction: () => {},
      unregisterToolbarAction: () => {},
      registerSidebarItem: () => {},
      unregisterSidebarItem: () => {},
    }),
    [server.path],
  );

  // The active plugin tab descriptor, if the active tab is a plugin tab.
  const activePluginTab = useMemo<PluginTab | undefined>(
    () => (getTab(activeTab) ?? undefined),
    [activeTab, getTab],
  );

  return (
    <>
      {/* Tab bar */}
      <div className="flex items-stretch border-b border-grid-bounds bg-bg-surface shrink-0">
        {allTabs.map((tab) => (
          <TabButton
            key={tab.id}
            label={tab.label}
            active={activeTab === tab.id}
            count={tab.id === "logs" ? logs.length : undefined}
            onClick={() => setActiveTab(tab.id)}
          />
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "logs" && (
        <>
          {/* Log terminal */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-grid-bounds shrink-0">
            <span className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
              latest.log
            </span>
            <span className="text-[10px] text-zinc-600 tabular-nums">
              {logs.length} {logs.length === 1 ? "line" : "lines"}
            </span>
          </div>
          <div
            ref={terminalRef as React.RefObject<HTMLDivElement>}
            onScroll={handleScroll}
            className="relative flex-1 min-h-0 overflow-y-auto bg-bg-core p-3 font-mono text-[11px] leading-relaxed"
          >
            {/* Floating "scroll to bottom" button */}
            {showScrollButton && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 right-3 z-10 w-7 h-7 flex items-center justify-center rounded border border-grid-bounds bg-bg-surface text-zinc-400 hover:text-zinc-100 shadow-lg opacity-70 hover:opacity-100 transition-opacity duration-200"
                title="Scroll to bottom"
              >
                ↓
              </button>
            )}
            {logs.length === 0 ? (
              <p className="text-zinc-700">
                no output yet — start the instance to begin streaming
              </p>
            ) : (
              logs.map((line, i) => {
                // Split out a leading timestamp (if any) so it renders dimmed.
                const { prefix, rest } = parseTimestamp(line);
                const segments = parseAnsi(rest);
                const tint = classifyLevelColor(line);
                return (
                  <div
                    key={i}
                    className="whitespace-pre-wrap break-all"
                    style={{ color: tint === "inherit" ? DEFAULT_FG : tint }}
                  >
                    {/* Timestamp prefix: dimmed, distinct color, rendered first. */}
                    {prefix ? (
                      <span style={{ color: TS_COLOR, opacity: 0.6 }}>
                        {prefix}
                      </span>
                    ) : null}
                    {segments.map((seg, j) => (
                      <span
                        key={j}
                        style={{
                          color: seg.style.color,
                          fontWeight: seg.style.bold ? 600 : undefined,
                          opacity: seg.style.dim ? 0.6 : undefined,
                        }}
                      >
                        {seg.text}
                      </span>
                    ))}
                  </div>
                );
              })
            )}
          </div>

          {/* Terminal input */}
          <div className="shrink-0 border-t border-grid-bounds bg-bg-surface px-3 py-2">
            <form onSubmit={handleSubmit} className="flex items-center gap-2">
              <span className="text-signal-high text-[11px] font-mono select-none">{">"}</span>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="start | stop | restart | install | or type to send stdin…"
                className="flex-1 bg-transparent font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 caret-signal-high"
                spellCheck={false}
                autoComplete="off"
              />
            </form>
          </div>
        </>
      )}

      {activeTab === "files" && (
        <FileEditorPanel serverId={server.id} />
      )}

      {activePluginTab && activeTab !== "logs" && activeTab !== "files" && (
        <PluginTabContent
          tab={activePluginTab}
          serverData={server}
          hostAPI={hostAPI}
        />
      )}
    </>
  );
}

/* ─── HeaderToolbar — lifecycle buttons + plugin toolbar actions ──────── */

interface HeaderToolbarProps {
  liveHex: string;
  liveStatus: string;
  isEffectivelyRunning: boolean;
  transitioning: boolean;
  hasInstallStep: boolean;
  installed: boolean;
  busy: boolean;
  launching: boolean;
  server: ServerInstance;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  install: () => Promise<void>;
  handleInstalled: () => Promise<void>;
  launch: () => Promise<void>;
}

/**
 * Header toolbar area — renders the live status badge, lifecycle buttons
 * (start/stop/restart/install), and any plugin-registered toolbar actions.
 */
function HeaderToolbar({
  liveHex, liveStatus, isEffectivelyRunning, transitioning,
  hasInstallStep, installed, busy, launching,
  server, restart, stop, install, handleInstalled, launch,
}: HeaderToolbarProps) {
  const { actions } = useToolbarActions();

  return (
    <div className="flex items-center gap-2 shrink-0">
      <span
        className="text-[11px] font-mono px-3 py-1.5 border"
        style={{ color: liveHex, borderColor: `${liveHex}55` }}
      >
        {liveStatus}
      </span>

      {isEffectivelyRunning ? (
        <>
          <button
            onClick={restart}
            disabled={transitioning}
            className="px-3 py-1.5 text-xs text-zinc-200 border border-signal-low hover:border-signal-high hover:text-signal-high font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            restart
          </button>
          <button
            onClick={stop}
            disabled={transitioning}
            className="px-3 py-1.5 text-xs text-bg-core bg-fault-vector hover:opacity-80 font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            stop
          </button>
        </>
      ) : (
        <>
          {hasInstallStep && (
            <button
              onClick={async () => {
                await install();
                await handleInstalled();
              }}
              disabled={transitioning || server.isOrphaned}
              className="px-3 py-1.5 text-xs text-zinc-200 border border-signal-low hover:border-signal-high hover:text-signal-high font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "installing…" : installed ? "re-install" : "install"}
            </button>
          )}
          <button
            onClick={launch}
            disabled={transitioning || server.isOrphaned}
            className="px-3 py-1.5 text-xs text-bg-core bg-signal-high hover:opacity-80 font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {launching ? "starting…" : "start"}
          </button>
        </>
      )}

      {/* Plugin toolbar actions */}
      {actions.map((action) => (
        <button
          key={action.id}
          onClick={() => void action.onClick()}
          disabled={action.disabled}
          className="px-3 py-1.5 text-xs text-zinc-200 border border-grid-bounds hover:border-signal-low hover:text-signal-high font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {action.icon && <span className="mr-1">{action.icon}</span>}
          {action.label}
        </button>
      ))}
    </div>
  );
}

/* ─── Tab Button ──────────────────────────────────────────────────────── */

interface TabButtonProps {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}

function TabButton({ label, active, count, onClick }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        px-4 py-1.5 text-[10px] tracking-[0.2em] uppercase font-semibold
        border-b-2 transition-colors
        ${active
          ? "border-signal-high text-zinc-200 bg-bg-core"
          : "border-transparent text-zinc-600 hover:text-zinc-400 hover:bg-bg-core/50"
        }
      `}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1.5 tabular-nums text-zinc-600">
          {count}
        </span>
      )}
    </button>
  );
}