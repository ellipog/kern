/**
 * Sidebar Item Registry — React context for managing plugin-registered
 * sidebar items in the app's left sidebar.
 *
 * The provider is placed at the App level so sidebar items persist across
 * server view changes.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { SidebarItem } from "../types/plugin";

/* ─── Context value ─────────────────────────────────────────────────────── */

interface SidebarItemRegistryContextValue {
  /** All currently registered sidebar items, sorted by order. */
  items: SidebarItem[];
  registerItem: (item: SidebarItem) => SidebarItem | undefined;
  unregisterItem: (itemId: string) => SidebarItem | undefined;
}

const SidebarItemRegistryContext =
  createContext<SidebarItemRegistryContextValue | null>(null);

/* ─── Provider ──────────────────────────────────────────────────────────── */

interface SidebarItemRegistryProviderProps {
  children: ReactNode;
}

export function SidebarItemRegistryProvider({
  children,
}: SidebarItemRegistryProviderProps) {
  const mapRef = useRef<Map<string, SidebarItem>>(new Map());
  const [items, setItems] = useState<SidebarItem[]>([]);

  const registerItem = useCallback((item: SidebarItem) => {
    const map = mapRef.current;
    const prev = map.get(item.id);
    map.set(item.id, item);
    const sorted = Array.from(map.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    setItems(sorted);
    return prev;
  }, []);

  const unregisterItem = useCallback((itemId: string) => {
    const map = mapRef.current;
    const prev = map.get(itemId);
    if (!prev) return undefined;
    map.delete(itemId);
    const sorted = Array.from(map.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    setItems(sorted);
    return prev;
  }, []);

  return (
    <SidebarItemRegistryContext.Provider
      value={{ items, registerItem, unregisterItem }}
    >
      {children}
    </SidebarItemRegistryContext.Provider>
  );
}

/* ─── Hook ──────────────────────────────────────────────────────────────── */

export function useSidebarItems(): SidebarItemRegistryContextValue {
  const ctx = useContext(SidebarItemRegistryContext);
  if (!ctx) {
    throw new Error(
      "useSidebarItems must be used within a SidebarItemRegistryProvider",
    );
  }
  return ctx;
}
