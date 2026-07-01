import { useCallback, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlugins } from "../../hooks/usePlugins";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PluginInstallDialog } from "./PluginInstallDialog";
import type { Manifest } from "../../types/manifest";

interface PluginManagerProps {
  /** Called when the user wants to go back to the server list. */
  onBack: () => void;
  /** Pre-loaded .kern file path from deep link (e.g., double-click in Explorer). */
  preselectedKernPath?: string | null;
}

/**
 * Plugin management view — lists every installed plugin with details and
 * exposes install / uninstall actions.
 *
 * Matches the kern dark-room palette. The view follows the same header +
 * content layout as ServerDetailView.
 */
export function PluginManager({ onBack, preselectedKernPath }: PluginManagerProps) {
  const { plugins, loading, error: loadError, refresh } = usePlugins();
  const [installOpen, setInstallOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-open installer if a .kern path was passed (deep link from file double-click)
  const [preselectedPath, setPreselectedPath] = useState<string | null>(
    // Initialize from prop if provided
    () => null
  );

  // Set preselected path when prop changes
  useEffect(() => {
    if (preselectedKernPath) {
      setPreselectedPath(preselectedKernPath);
      setInstallOpen(true);
    }
  }, [preselectedKernPath]);

  // Stabilised callbacks so child dialog effects don't re-register on every render.
  const closeInstall = useCallback(() => setInstallOpen(false), []);
  const handleInstalled = useCallback(() => { void refresh(); }, [refresh]);

  // ── uninstall confirmation state ───────────────────────────────────────
  const [pendingUninstall, setPendingUninstall] = useState<Manifest | null>(null);

  async function handleUninstall() {
    if (!pendingUninstall) return;
    const id = pendingUninstall.id;
    setPendingUninstall(null);
    setActionError(null);
    try {
      await invoke("uninstall_plugin", { id });
      void refresh();
    } catch (e) {
      setActionError(String(e));
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ────────────────────────────────────────────────────── */}
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
              <h2 className="text-sm text-zinc-100">plugins</h2>
              <p className="text-[11px] text-zinc-500 font-mono truncate">
                {loading
                  ? "loading…"
                  : `${plugins.length} plugin${plugins.length !== 1 ? "s" : ""} installed`}
              </p>
            </div>
          </div>

          <button
            onClick={() => setInstallOpen(true)}
            className="px-3 py-1.5 text-xs text-bg-core bg-signal-high hover:opacity-80 font-semibold transition-opacity"
          >
            + install
          </button>
        </div>
      </div>

      {/* ── Error banner ──────────────────────────────────────────────── */}
      {(loadError || actionError) && (
        <p className="m-4 text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1">
          {loadError ?? actionError}
        </p>
      )}

      {/* ── Loading state ─────────────────────────────────────────────── */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[11px] text-zinc-600">loading plugins…</p>
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────── */}
      {!loading && plugins.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-xs text-zinc-500 mb-2">
              no plugins installed yet
            </p>
            <p className="text-[11px] text-zinc-600 mb-4">
              Install a community plugin to extend the host.
            </p>
            <button
              onClick={() => setInstallOpen(true)}
              className="px-3 py-1.5 text-xs text-bg-core bg-signal-high hover:opacity-80 font-semibold transition-opacity"
            >
              + install plugin
            </button>
          </div>
        </div>
      )}

      {/* ── Plugin list ───────────────────────────────────────────────── */}
      {!loading && plugins.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-grid-bounds text-zinc-600 uppercase tracking-wider">
                <th className="text-left px-4 py-2 font-normal">name</th>
                <th className="text-left px-4 py-2 font-normal">id</th>
                <th className="text-left px-4 py-2 font-normal">version</th>
                <th className="text-left px-4 py-2 font-normal">author</th>
                <th className="text-right px-4 py-2 font-normal">actions</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((plugin) => (
                <tr
                  key={plugin.id}
                  className="border-b border-grid-bounds/50 hover:bg-bg-core transition-colors"
                >
                  <td className="px-4 py-2.5 text-zinc-200 font-medium">
                    {plugin.displayName}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 font-mono">
                    {plugin.id}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {plugin.version}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {plugin.author}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => setPendingUninstall(plugin)}
                      className="px-2 py-1 text-[10px] text-fault-vector border border-fault-vector/40 hover:bg-fault-vector/10 font-semibold transition-colors uppercase tracking-wider"
                    >
                      uninstall
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Uninstall confirmation dialog ─────────────────────────────── */}
      <ConfirmDialog
        open={pendingUninstall !== null}
        title="uninstall plugin"
        message={
          pendingUninstall
            ? `"${pendingUninstall.displayName}" (${pendingUninstall.id}) will be permanently removed from the plugin registry. This cannot be undone — server instances using this plugin will stop working.`
            : ""
        }
        confirmLabel="uninstall"
        cancelLabel="cancel"
        variant="danger"
        onConfirm={handleUninstall}
        onCancel={() => setPendingUninstall(null)}
      />

      {/* ── Install dialog ──────────────────────────────────────────── */}
      <PluginInstallDialog
        isOpen={installOpen}
        onClose={closeInstall}
        onInstalled={handleInstalled}
        initialPath={preselectedPath ?? undefined}
      />
    </div>
  );
}
