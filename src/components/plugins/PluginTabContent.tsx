/**
 * PluginTabContent — renders a single plugin-registered tab inside an open
 * Shadow Root for style isolation.
 *
 * Similar to PluginWrapper but for tab content rather than the plugin panel.
 * The mount function and cleanup are provided by the PluginTab descriptor
 * rather than loaded from a manifest.
 */

import { useEffect, useRef, useState } from "react";
import type { PluginTab } from "../../types/plugin";
import type { ServerInstance } from "../../types/server";
import type { HostAPI } from "../../types/plugin";

interface PluginTabContentProps {
  /** The plugin tab descriptor providing mount/unmount. */
  tab: PluginTab;
  /** Server data forwarded to the tab's mount() function. */
  serverData: ServerInstance;
  /** Host API forwarded to the tab's mount() function. */
  hostAPI: HostAPI;
}

export function PluginTabContent({
  tab,
  serverData,
  hostAPI,
}: PluginTabContentProps) {
  const shadowHostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = shadowHostRef.current;
    if (!host) return;

    let mounted = false;

    async function mountTab() {
      try {
        // Create (or reuse) a Shadow Root on the host element.
        const h = host!;
        const shadow =
          h.shadowRoot || h.attachShadow({ mode: "open" });
        // Clear any previous content.
        while (shadow.lastChild) shadow.removeChild(shadow.lastChild);

        // Inject the plugin's CSS into the Shadow Root so tab content is
        // styled. PluginBoot enriches every registered tab with its cssUrl.
        if (tab.cssUrl) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = tab.cssUrl;
          shadow.appendChild(link);
          await new Promise<void>((resolve) => {
            link.onload = () => resolve();
            link.onerror = () => {
              console.warn(
                `[PluginTabContent] failed to load CSS for tab "${tab.id}": ${tab.cssUrl}`,
              );
              resolve(); // Non-fatal — proceed without styles
            };
          });
          if (cancelled) return;
        }

        // Create a mount point inside the shadow root.
        const mountPoint = document.createElement("div");
        mountPoint.style.width = "100%";
        mountPoint.style.height = "100%";
        shadow.appendChild(mountPoint);

        if (cancelled) return;

        // Call the tab's mount function.
        await tab.mount(mountPoint, serverData, hostAPI);
        if (cancelled) return;
        mounted = true;
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
      }
    }

    void mountTab();

    return () => {
      cancelled = true;
      // Call the tab's unmount if it was successfully mounted.
      if (mounted) {
        try {
          tab.unmount?.();
        } catch {
          // A throwing unmount shouldn't block teardown.
        }
      }
      // Clear shadow root children.
      const h = host!;
      if (h.shadowRoot) {
        while (h.shadowRoot.lastChild) {
          h.shadowRoot.removeChild(h.shadowRoot.lastChild);
        }
      }
    };
  }, [tab, serverData, hostAPI]);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={shadowHostRef} className="w-full h-full" />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-core/80">
          <p className="text-[11px] text-fault-vector px-4 text-center">
            tab error: {error}
          </p>
        </div>
      )}
    </div>
  );
}
