/**
 * Server instance + global config types.
 * Spec: documentation/ArchitecturePlan.md §2 (Core Registry Schema).
 * Mirrors the Rust structs in src-tauri/src/config.rs (camelCase on the wire).
 */

/** Lifecycle of a tracked server instance. */
export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "installing" | "error";

/**
 * Fields an instance can be sorted by. Mirrors `ServerInstance`:
 *   name → human-readable label
 *   serverType → plugin id backing the instance (e.g. "web_server")
 *   status → lifecycle state (running, stopped, error…)
 *   path → absolute filesystem path to the working directory
 */
export type SortKey = "name" | "serverType" | "status" | "path";

/** A complete sort preference: which field, and which direction. */
export interface SortPref {
  key: SortKey;
  direction: "asc" | "desc";
}

/** A tracked server instance in config.json. */
export interface ServerInstance {
  /** Stable identifier, e.g. "srv_9f82b1a0". */
  id: string;
  /** Human-readable label. */
  name: string;
  /** Plugin id backing this instance, e.g. "web_server". */
  serverType: string;
  /** Absolute filesystem path to the instance working directory. */
  path: string;
  /** Last known runtime status. */
  status: ServerStatus;
  /** True when the instance path is no longer accessible on disk. */
  isOrphaned: boolean;
  /** User-selected configuration values surfaced by the plugin's configSchema. */
  userOverrides: Record<string, string>;
}

/** Global application settings. */
export interface AppSettings {
  /** Default sandbox path used when no custom location is chosen. */
  defaultSandboxPath: string;
}

/** Root config.json document. */
export interface AppConfig {
  version: string;
  settings: AppSettings;
  servers: Record<string, ServerInstance>;
}

/** Payload accepted by the create_server command. */
export type NewServerInput = Omit<ServerInstance, "id" | "status" | "isOrphaned"> & {
  /** Optional explicit id; generated server-side when omitted. */
  id?: string;
};
