/**
 * Toolbar Action Registry — React context for managing plugin-registered
 * toolbar actions in the server detail view header.
 *
 * Each ServerDetailView creates its own ToolbarActionRegistryProvider so
 * actions are scoped to the current server view.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { ToolbarAction } from "../types/plugin";

/* ─── Context value ─────────────────────────────────────────────────────── */

interface ToolbarActionRegistryContextValue {
  /** All currently registered toolbar actions, sorted by order. */
  actions: ToolbarAction[];
  registerAction: (action: ToolbarAction) => ToolbarAction | undefined;
  unregisterAction: (actionId: string) => ToolbarAction | undefined;
}

const ToolbarActionRegistryContext =
  createContext<ToolbarActionRegistryContextValue | null>(null);

/* ─── Provider ──────────────────────────────────────────────────────────── */

interface ToolbarActionRegistryProviderProps {
  children: ReactNode;
}

export function ToolbarActionRegistryProvider({
  children,
}: ToolbarActionRegistryProviderProps) {
  const mapRef = useRef<Map<string, ToolbarAction>>(new Map());
  const [actions, setActions] = useState<ToolbarAction[]>([]);

  const registerAction = useCallback((action: ToolbarAction) => {
    const map = mapRef.current;
    const prev = map.get(action.id);
    map.set(action.id, action);
    const sorted = Array.from(map.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    setActions(sorted);
    return prev;
  }, []);

  const unregisterAction = useCallback((actionId: string) => {
    const map = mapRef.current;
    const prev = map.get(actionId);
    if (!prev) return undefined;
    map.delete(actionId);
    const sorted = Array.from(map.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    setActions(sorted);
    return prev;
  }, []);

  return (
    <ToolbarActionRegistryContext.Provider
      value={{ actions, registerAction, unregisterAction }}
    >
      {children}
    </ToolbarActionRegistryContext.Provider>
  );
}

/* ─── Hook ──────────────────────────────────────────────────────────────── */

export function useToolbarActions(): ToolbarActionRegistryContextValue {
  const ctx = useContext(ToolbarActionRegistryContext);
  if (!ctx) {
    throw new Error(
      "useToolbarActions must be used within a ToolbarActionRegistryProvider",
    );
  }
  return ctx;
}
