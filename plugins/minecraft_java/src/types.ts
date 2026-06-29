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

/** Minimal shape of the hostAPI object passed to mount(). */
export interface HostAPI {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  serverPath: string;
}

/** One-step in a multi-step install sequence. */
export interface InstallStep {
  label: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
}
