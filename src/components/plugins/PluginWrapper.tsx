import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ServerInstance } from "../../types/server";

interface PluginWrapperProps {
  /** Plugin id backing the instance. */
  pluginId: string;
  /** Server data handed to the plugin's mount() function. */
  serverData: ServerInstance;
  /** Whether the panel is currently collapsed. */
  collapsed: boolean;
  /** Toggle handler for collapse state. */
  onToggleCollapsed: () => void;
}

/**
 * Isolated Shadow DOM container for community plugin UIs.
 *
 * Spec: documentation/ArchitecturePlan.md §4 (Isolated Panel Container).
 * Every plugin UI is mounted inside an open Shadow Root so its styles cannot
 * bleed into (or be affected by) the host's Tailwind layer. The plugin's
 * compiled ESM bundle is imported at runtime and asked to `mount()` into a
 * node inside the shadow root.
 *
 * Plugin assets live outside the Vite dev server (in AppData), so the UI entry
 * path is resolved to an `asset://` URL via convertFileSrc.
 *
 * ~~~ DOM architecture (avoids React reconciliation conflicts) ~~~
 *
 *   <div className="p-3 min-h-[120px]">         ← React-managed outer container
 *     <div ref={shadowHostRef} />                ← Shadow host: React never adds/removes
 *                                                  children here. The Shadow Root is
 *                                                  attached to this element.
 *     {status !== "ready" && (                   ← Status overlay: React-managed sibling,
 *       <div>...loading/error/none...</div>        fully under React's reconciliation.
 *     )}
 *   </div>
 *
 * The KEY INSIGHT: by keeping the shadow host and the React-rendered status
 * messages as *siblings*, we never need to call `innerHTML` on a React-managed
 * element. This eliminates the "Failed to execute 'removeChild' on 'Node'"
 * error that occurs when React tries to reconcile children that were destroyed
 * by direct DOM manipulation.
 */
export function PluginWrapper({ pluginId, serverData, collapsed, onToggleCollapsed }: PluginWrapperProps) {
  const shadowHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "none">("loading");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const host = shadowHostRef.current;
    if (!host) return;
    // Track the loaded module so cleanup can invoke unmount() (lets plugins
    // stop timers / detach listeners instead of leaking across re-mounts).
    let loaded: { unmount?: () => void } | null = null;

    async function mount(host: HTMLDivElement) {
      try {
        // 1. Resolve the plugin's UI entry to an asset:// URL.
        const absPath = await invoke<string | null>("get_plugin_ui_path", { id: pluginId });
        if (cancelled) return;
        if (!absPath) {
          setStatus("none");
          setMessage("this plugin has no UI entry");
          return;
        }

        // 2. Create (or reuse) a Shadow Root on the dedicated host element.
        //    We never call innerHTML on the host — React doesn't manage its
        //    children, so there's nothing to clear in the light DOM.
        const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
        // Clear the shadow root's children when reusing so we start fresh.
        while (shadow.lastChild) shadow.removeChild(shadow.lastChild);

        // 3. Create a mount element inside the shadow root.
        const mountPoint = document.createElement("div");
        mountPoint.style.width = "100%";
        shadow.appendChild(mountPoint);

        // 4. Inject the plugin's stylesheet if one ships next to the bundle.
        //    Wait for it to load before mounting so the user never sees
        //    unstyled content (FOUC) — the panel stays hidden until the CSS
        //    is fully applied.
        const cssUrl = convertFileSrc(absPath.replace(/\.js$/, ".css"));
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        await new Promise<void>((resolve, reject) => {
          link.onload = () => resolve();
          link.onerror = () => reject(new Error(`failed to load plugin CSS: ${cssUrl}`));
          shadow.appendChild(link);
        });
        if (cancelled) return;

        // 5. Runtime-import the plugin code and mount it.
        const scriptUrl = convertFileSrc(absPath);
        const plugin = await import(/* @vite-ignore */ scriptUrl);
        if (cancelled) return;
        if (typeof plugin.mount === "function") {
          // Pass a host API object so the plugin can read .env files,
          // call Tauri commands, open folders, or listen to backend event streams.
          const hostAPI = {
            invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
            serverPath: serverData.path,
            listen: (event: string, handler: (payload: unknown) => void) =>
              listen(event, (e) => handler(e.payload)),
          };
          plugin.mount(mountPoint, serverData, hostAPI);
          loaded = plugin;
          setStatus("ready");
        } else {
          setStatus("error");
          setMessage("plugin bundle has no mount() export");
        }
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setMessage(String(err));
      }
    }

    void mount(host);

    // Cleanup: let the plugin tear itself down, then clear the shadow DOM.
    // We DO NOT touch the host's light DOM (React manages that via siblings).
    return () => {
      cancelled = true;
      try {
        loaded?.unmount?.();
      } catch {
        // A throwing unmount() shouldn't block host teardown.
      }
      // Clear shadow root children only — never touch the host's light DOM.
      if (host.shadowRoot) {
        while (host.shadowRoot.lastChild) {
          host.shadowRoot.removeChild(host.shadowRoot.lastChild);
        }
      }
    };
  }, [pluginId, serverData]);

  return (
    <div className="border border-grid-bounds bg-bg-surface">
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="flex items-center justify-between w-full px-3 py-1.5 border-b border-grid-bounds cursor-pointer hover:bg-white/[0.03] transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <svg
            className={`w-3 h-3 text-zinc-500 transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
            plugin panel
          </span>
        </span>
        <span
          className={`text-[10px] ${status === "ready"
            ? "text-signal-high"
            : status === "error"
              ? "text-fault-vector"
              : "text-zinc-600"
            }`}
        >
          {status}
        </span>
      </button>
      <div className={`p-3 min-h-[80px] ${collapsed ? "hidden" : ""}`}>
        {/*
          Dedicated shadow DOM host — React never renders children into this
          <div>, so attaching a shadow root to it never conflicts with React's
          reconciliation. The shadow root is attached to this element.
        */}
        <div ref={shadowHostRef} />

        {/*
          Status overlays are a SIBLING of the shadow host, fully managed by
          React. When status changes to "ready", this entire block is removed
          from the DOM by React normally — no direct DOM manipulation needed.
        */}
        {status !== "ready" && (
          <div>
            {status === "loading" && (
              <p className="text-[11px] text-zinc-600">loading plugin UI…</p>
            )}
            {status === "error" && (
              <p className="text-[11px] text-fault-vector">failed to load: {message}</p>
            )}
            {status === "none" && (
              <p className="text-[11px] text-zinc-600">{message}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
