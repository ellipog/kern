/**
 * Plugin Tab Registry — React context for managing plugin-registered tabs
 * in the server detail view.
 *
 * Each ServerDetailView creates its own PluginTabRegistryProvider so tabs
 * are scoped to the current server view. Plugins register tabs via the
 * HostAPI.registerTab() method, which calls into this context.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { PluginTab } from "../types/plugin";

/* ─── Context value ─────────────────────────────────────────────────────── */

interface PluginTabRegistryContextValue {
  /** All currently registered plugin tabs. */
  tabs: PluginTab[];
  /**
   * Register a tab. If a tab with the same id already exists it is replaced.
   * Returns the tab that was replaced/removed, or undefined.
   */
  registerTab: (tab: PluginTab) => PluginTab | undefined;
  /** Unregister a tab by id. Returns the removed tab, or undefined. */
  unregisterTab: (tabId: string) => PluginTab | undefined;
  /** Look up a registered tab by id. */
  getTab: (tabId: string) => PluginTab | undefined;
}

const PluginTabRegistryContext =
  createContext<PluginTabRegistryContextValue | null>(null);

/* ─── Provider ──────────────────────────────────────────────────────────── */

interface PluginTabRegistryProviderProps {
  children: ReactNode;
}

export function PluginTabRegistryProvider({
  children,
}: PluginTabRegistryProviderProps) {
  // Use a ref-backed map for O(1) lookups + a state array for renders.
  const mapRef = useRef<Map<string, PluginTab>>(new Map());
  const [tabs, setTabs] = useState<PluginTab[]>([]);

  const registerTab = useCallback((tab: PluginTab) => {
    const map = mapRef.current;
    const prev = map.get(tab.id);
    map.set(tab.id, tab);
    setTabs(Array.from(map.values()));
    return prev;
  }, []);

  const unregisterTab = useCallback((tabId: string) => {
    const map = mapRef.current;
    const prev = map.get(tabId);
    if (!prev) return undefined;
    map.delete(tabId);
    setTabs(Array.from(map.values()));
    return prev;
  }, []);

  const getTab = useCallback((tabId: string) => {
    return mapRef.current.get(tabId);
  }, []);

  return (
    <PluginTabRegistryContext.Provider
      value={{ tabs, registerTab, unregisterTab, getTab }}
    >
      {children}
    </PluginTabRegistryContext.Provider>
  );
}

/* ─── Hook ──────────────────────────────────────────────────────────────── */

/**
 * Access the plugin tab registry context.
 * Must be used within a PluginTabRegistryProvider.
 */
export function usePluginTabs(): PluginTabRegistryContextValue {
  const ctx = useContext(PluginTabRegistryContext);
  if (!ctx) {
    throw new Error(
      "usePluginTabs must be used within a PluginTabRegistryProvider",
    );
  }
  return ctx;
}
