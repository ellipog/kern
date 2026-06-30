/** Mirrors JavaInstall from java.rs */
export interface JavaInstall {
  path: string;
  version: string;
  majorVersion: number;
}

/** Mirrors DownloadProgress from download.rs */
export interface DownloadProgress {
  bytes: number;
  total: number;
}

/** The server instance data passed to the plugin mount function. */
export interface ServerInstance {
  id: string;
  name: string;
  serverType: string;
  path: string;
  status: string;
  isOrphaned: boolean;
  userOverrides: Record<string, string>;
}

/** A tab the plugin can register in the server detail view. */
export interface PluginTab {
  id: string;
  label: string;
  mount: (mountPoint: HTMLElement, serverData: ServerInstance, hostAPI: HostAPI) => void | Promise<void>;
  unmount?: () => void;
}

/** A toolbar action — a button rendered in the header toolbar area. */
export interface ToolbarAction {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void | Promise<void>;
  order?: number;
  disabled?: boolean;
}

/** A sidebar item — a clickable entry in the left sidebar. */
export interface SidebarItem {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
  order?: number;
}

/** Minimal shape of the hostAPI object passed to mount(). */
export interface HostAPI {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  serverPath: string;
  /** Subscribe to a Tauri event. Returns an unlisten function. */
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
  /** Register a custom tab in the server detail view. */
  registerTab: (tab: PluginTab) => void;
  /** Unregister a previously-registered tab by id. */
  unregisterTab: (tabId: string) => void;
  /** Register a toolbar action button. */
  registerToolbarAction: (action: ToolbarAction) => void;
  /** Unregister a toolbar action by id. */
  unregisterToolbarAction: (actionId: string) => void;
  /** Register a sidebar item. */
  registerSidebarItem: (item: SidebarItem) => void;
  /** Unregister a sidebar item by id. */
  unregisterSidebarItem: (itemId: string) => void;
}

/** One-step in a multi-step install sequence. */
export interface InstallStep {
  label: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
}
