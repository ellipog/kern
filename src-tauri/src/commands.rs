//! Tauri commands exposing the server registry CRUD + process lifecycle.
//!
//! Spec: documentation/ArchitecturePlan.md §2 (Phase 1 — standard CRUD
//! operations via Rust file commands, plus orphaned-state handling) and
//! §5 (Phase 2 — variable process lifecycle execution + log streaming).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::config::{self, AppConfig, ServerInstance};
use crate::manifest;
use crate::metrics::{InstanceMetrics, MetricsState};
use crate::process;
use crate::scaffold;

/// Returns the full config document, with `is_orphaned` refreshed on read.
#[tauri::command]
pub fn get_config(app_handle: AppHandle) -> Result<AppConfig, String> {
    config::load_config(&app_handle)
}

/// Returns just the tracked server instances as a list.
#[tauri::command]
pub fn get_servers(app_handle: AppHandle) -> Result<Vec<ServerInstance>, String> {
    let cfg = config::load_config(&app_handle)?;
    Ok(cfg.servers.into_values().collect())
}

/// Input accepted by `create_server`. Fields the host owns (`id`, `status`,
/// `is_orphaned`) are filled in server-side.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewServerInput {
    pub name: String,
    pub server_type: String,
    pub path: String,
    #[serde(default)]
    pub user_overrides: HashMap<String, String>,
}

/// Creates a new server instance and returns the persisted record (with its
/// generated id and resolved orphaned status).
///
/// After persisting, the plugin's `scaffold` files are written into the
/// instance directory — so the path exists immediately and the instance isn't
/// orphaned on first load. Scaffolding is best-effort and never blocks creation.
#[tauri::command]
pub fn create_server(
    app_handle: AppHandle,
    input: NewServerInput,
) -> Result<ServerInstance, String> {
    let mut cfg = config::load_config(&app_handle)?;

    let instance = ServerInstance {
        id: config::generate_id(),
        name: input.name,
        server_type: input.server_type,
        path: input.path.clone(),
        status: "stopped".to_string(),
        is_orphaned: false,
        user_overrides: input.user_overrides.clone(),
    };

    cfg.servers.insert(instance.id.clone(), instance.clone());
    config::save_config(&app_handle, &cfg)?;

    // Scaffold starter files from the plugin manifest (if installed + declared).
    // Best-effort: a missing/unknown plugin just leaves the folder empty.
    if let Ok(manifest_path) = manifest_path_for(&app_handle, &instance.server_type) {
        if manifest_path.exists() {
            if let Ok(manifest) = manifest::load(&manifest_path) {
                scaffold::write(
                    std::path::Path::new(&instance.path),
                    &manifest,
                    &instance.user_overrides,
                );
            }
        }
    }

    // Materialize the instance's overrides into a .env file so the launched
    // process has them available. Each override becomes a KEY=value line.
    // Best-effort, never blocks creation. Skipped entirely when there are no
    // overrides — no point writing an empty file.
    if !instance.user_overrides.is_empty() {
        let env_path = std::path::Path::new(&instance.path).join(".env");
        let content: String = instance
            .user_overrides
            .iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect();
        let _ = std::fs::write(&env_path, content);
    }

    Ok(instance)
}

/// Updates an existing instance by id. Returns an error if the id is unknown.
#[tauri::command]
pub fn update_server(
    app_handle: AppHandle,
    server: ServerInstance,
) -> Result<ServerInstance, String> {
    let mut cfg = config::load_config(&app_handle)?;

    let updated = {
        let entry = cfg
            .servers
            .get_mut(&server.id)
            .ok_or_else(|| format!("server '{}' not found", server.id))?;
        entry.name = server.name;
        entry.server_type = server.server_type;
        entry.path = server.path;
        // Status is host-owned, so we keep whatever the caller sent (Phase 2
        // will drive it from the shell lifecycle).
        entry.status = server.status;
        entry.user_overrides = server.user_overrides;
        entry.is_orphaned = server.is_orphaned;
        entry.clone()
    };

    config::save_config(&app_handle, &cfg)?;
    Ok(updated)
}

/// Deletes an instance by id. Missing ids are treated as already-deleted (Ok).
#[tauri::command]
pub fn delete_server(app_handle: AppHandle, id: String) -> Result<(), String> {
    let mut cfg = config::load_config(&app_handle)?;
    cfg.servers.remove(&id);
    config::save_config(&app_handle, &cfg)?;
    Ok(())
}

/// Deletes an instance's working directory from disk. Best-effort — missing
/// directories are treated as already gone (Ok). Used alongside `delete_server`
/// when the user opts to also remove the folder.
#[tauri::command]
pub fn delete_server_folder(app_handle: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let path = std::path::Path::new(&instance.path);
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("failed to remove '{}': {e}", path.display()))?;
    }
    Ok(())
}

/// Opens a path in the system's default file manager, showing its contents.
/// Uses the `open` crate which handles platform differences (Explorer on
/// Windows, Finder on macOS, xdg-open on Linux).
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    open::that(p).map_err(|e| format!("failed to open '{}': {e}", path))
}

/// Re-checks every instance's path on disk and returns the refreshed list.
#[tauri::command]
pub fn refresh_orphaned_status(
    app_handle: AppHandle,
) -> Result<Vec<ServerInstance>, String> {
    let mut cfg = config::load_config(&app_handle)?;
    config::refresh_orphaned(&mut cfg);
    config::save_config(&app_handle, &cfg)?;
    Ok(cfg.servers.into_values().collect())
}

/// Returns true if the instance currently has a running child process.
#[tauri::command]
pub fn is_server_running(app_handle: AppHandle, id: String) -> bool {
    process::is_running(&app_handle, &id)
}

/// Lightweight status update — changes just the persisted status for an
/// instance without touching any other field. Used by the frontend to sync
/// persisted state when a process exits or errors.
#[tauri::command]
pub fn update_server_status(app_handle: AppHandle, id: String, status: String) -> Result<(), String> {
    let mut cfg = config::load_config(&app_handle)?;
    if let Some(instance) = cfg.servers.get_mut(&id) {
        instance.status = status;
        config::save_config(&app_handle, &cfg)?;
    }
    Ok(())
}

/// Returns live CPU/RAM telemetry for a running instance, driven by the
/// instance's process tree. When the instance isn't running (no tracked PID),
/// returns a zeroed reading tagged with its persisted/orphaned status so the
/// radar idles cleanly instead of showing stale load.
#[tauri::command]
pub fn get_instance_metrics(
    app_handle: AppHandle,
    id: String,
) -> Result<InstanceMetrics, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let status = if instance.is_orphaned {
        "orphaned"
    } else {
        instance.status.as_str()
    };

    // Only sample live load when a process is actually tracked. An "error" or
    // transient status with no live process still falls through to the idle
    // reading below, which is the right thing to show.
    if let Some(pid) = process::pid_for(&app_handle, &id) {
        let state: tauri::State<'_, MetricsState> = app_handle.state();
        if let Some(m) = state.instance_metrics(pid, status) {
            return Ok(m);
        }
    }

    Ok(InstanceMetrics {
        cpu: 0.0,
        ram: 0.0,
        status: status.to_string(),
    })
}

/// Returns host-wide CPU/RAM telemetry, used by the empty-state radar so the
/// dashboard pulses with the real machine load even when no instances exist.
#[tauri::command]
pub fn get_host_metrics(app_handle: AppHandle) -> Result<InstanceMetrics, String> {
    let state: tauri::State<'_, MetricsState> = app_handle.state();
    Ok(state.host_metrics())
}

/// Locates the manifest for a plugin id under `<app_data>/plugins/<id>/`.
fn manifest_path_for(app_handle: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    let base = config::config_dir(app_handle)?;
    Ok(base.join("plugins").join(plugin_id).join("manifest.json"))
}

/// Resolves a lifecycle step for the given runtime.
///
/// Plugins may declare runtime-specific steps as `start.node`, `start.rust`,
/// etc. — useful when a runtime changes the command entirely (e.g. a Rust bot
/// runs via `cargo run`, not `rust <file>`). Falls back to the generic step
/// name when no runtime-qualified variant exists.
fn lifecycle_step<'m>(
    manifest: &'m manifest::Manifest,
    step: &str,
    runtime: Option<&str>,
) -> Result<&'m manifest::LifecycleStep, String> {
    if let Some(rt) = runtime {
        let qualified = format!("{step}.{rt}");
        if let Some(found) = manifest.lifecycle.get(&qualified) {
            return Ok(found);
        }
    }
    manifest
        .lifecycle
        .get(step)
        .ok_or_else(|| format!("plugin '{}' has no '{step}' lifecycle step", manifest.id))
}

/// Shared logic for running any lifecycle step. Loads the instance + manifest,
/// resolves the step (with runtime qualification), substitutes variables,
/// spawns via `process::launch`, and sets the persisted status.
///
/// On spawn failure the persisted status is set to "error" before the error
/// is returned, so the UI never sees a stale "starting" / "installing" state.
fn run_step(app_handle: &AppHandle, id: &str, step_name: &str) -> Result<(), String> {
    if process::is_running(app_handle, id) {
        return Err(format!("instance '{id}' is already running"));
    }

    let cfg = config::load_config(app_handle)?;
    let instance = cfg
        .servers
        .get(id)
        .ok_or_else(|| format!("server '{id}' not found"))?
        .clone();
    if instance.is_orphaned {
        return Err(format!(
            "instance '{id}' is orphaned (path missing): {}",
            instance.path
        ));
    }

    let manifest_path = manifest_path_for(app_handle, &instance.server_type)?;
    let manifest = manifest::load(&manifest_path)?;

    let runtime = instance.user_overrides.get("runtime").map(String::as_str);
    let step = lifecycle_step(&manifest, step_name, runtime)?;

    let command = process::resolve_variables(&step.command, &instance.user_overrides);
    let args: Vec<String> = step
        .args
        .iter()
        .map(|a| process::resolve_variables(a, &instance.user_overrides))
        .collect();

    // Set a transient status like "starting", "installing", etc.
    let transient = format!("{step_name}-ing");
    set_status(app_handle, id, &transient)?;

    if let Err(e) = process::launch(app_handle, id, std::path::Path::new(&instance.path), &command, &args) {
        // Spawn failed — roll back to error so the UI isn't stuck in a
        // transient state.
        set_status(app_handle, id, "error")?;
        return Err(e);
    }

    // Spawn succeeded. For "start" the status advances to "running"; other
    // steps (install, build) stay in the background — the frontend will
    // receive an Exited event when they complete and can reconcile status.
    if step_name == "start" {
        set_status(app_handle, id, "running")?;
    }
    Ok(())
}

/// Launches a server instance's "start" lifecycle step.
///
/// Resolves the command + args from the plugin manifest's lifecycle, preferring
/// a runtime-qualified variant (`start.<runtime>`) when one exists, applies
/// `{{userOverrides.*}}` substitution, spawns the process, and streams its
/// output to `<instance.path>/latest.log` + a `log:<id>:stream` event.
#[tauri::command]
pub fn launch_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    run_step(&app_handle, &id, "start")
}

/// Runs an arbitrary lifecycle step (install, build, test, etc.) from the
/// instance's plugin manifest. The step name is resolved with runtime
/// qualification (e.g. `install.rust` when the instance has `runtime=rust`).
///
/// Unlike `launch_server_instance`, the status is set to `{stepName}-ing`
/// rather than "running", since non-start steps are expected to exit on
/// their own. The frontend should listen for the Exited event to reconcile.
#[tauri::command]
pub fn run_lifecycle_step(
    app_handle: AppHandle,
    id: String,
    step_name: String,
) -> Result<(), String> {
    run_step(&app_handle, &id, &step_name)
}

/// Runs the "install" lifecycle step (e.g. `npm install`, `cargo build`).
/// Convenience wrapper around `run_lifecycle_step`.
#[tauri::command]
pub fn install_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    run_step(&app_handle, &id, "install")
}

/// Restarts a running instance: stops the current process, then starts it
/// again via the "start" lifecycle step.
///
/// If the instance isn't running, returns an error rather than silently
/// starting — callers should check `is_server_running` first.
#[tauri::command]
pub fn restart_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    if !process::is_running(&app_handle, &id) {
        return Err(format!("instance '{id}' is not running"));
    }

    set_status(&app_handle, &id, "stopping")?;
    process::stop(&app_handle, &id)?;

    // Brief pause lets the OS release resources before re-spawning.
    std::thread::sleep(std::time::Duration::from_millis(300));

    run_step(&app_handle, &id, "start")
}

/// Stops a running instance. Idempotent — Ok if it wasn't running.
#[tauri::command]
pub fn stop_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    set_status(&app_handle, &id, "stopping")?;
    process::stop(&app_handle, &id)?;
    set_status(&app_handle, &id, "stopped")?;
    Ok(())
}

/// Writes data to a running instance's stdin stream.
///
/// The frontend calls this when the user types a command into the terminal
/// input box. The data (already newline-terminated by the frontend) is piped
/// directly to the spawned child's stdin.
#[tauri::command]
pub fn write_stdin_to_instance(
    app_handle: AppHandle,
    id: String,
    data: String,
) -> Result<(), String> {
    process::write_stdin(&app_handle, &id, &data)
}

/// Returns the tail of an instance's latest.log (last `max_lines`).
#[tauri::command]
pub fn get_log_tail(
    app_handle: AppHandle,
    id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let log_path = PathBuf::from(&instance.path).join("latest.log");
    if !log_path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&log_path)
        .map_err(|e| format!("failed to read '{}': {e}", log_path.display()))?;
    let mut lines: Vec<&str> = raw.lines().collect();
    let limit = max_lines.unwrap_or(500);
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(lines.iter().map(|s| s.to_string()).collect())
}

/// Helper: writes a new status for an instance and persists it. Re-reads the
/// config first to avoid clobbering concurrent edits.
fn set_status(app_handle: &AppHandle, id: &str, status: &str) -> Result<(), String> {
    let mut cfg = config::load_config(app_handle)?;
    if let Some(instance) = cfg.servers.get_mut(id) {
        instance.status = status.to_string();
        config::save_config(app_handle, &cfg)?;
    }
    Ok(())
}

/// Reads a specific variable from an instance's .env file.
/// Returns None if the file or variable doesn't exist.
#[tauri::command]
pub fn read_env_file(app_handle: AppHandle, id: String, var_name: String) -> Result<Option<String>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let env_path = std::path::Path::new(&instance.path).join(".env");
    if !env_path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&env_path)
        .map_err(|e| format!("failed to read .env: {e}"))?;
    // Parse key=value lines (simple parser, no value quoting)
    for line in raw.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == var_name {
                return Ok(Some(value.trim().to_string()));
            }
        }
    }
    Ok(None)
}

/// Checks whether a relative file exists inside an instance's working directory.
/// Returns true if the file exists, false otherwise (missing file = not installed).
#[tauri::command]
pub fn server_file_exists(app_handle: AppHandle, id: String, rel_path: String) -> Result<bool, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = std::path::Path::new(&instance.path).join(&rel_path);
    Ok(target.exists())
}

/// Writes content to a relative file inside an instance's working directory.
/// Creates parent directories if missing. Used for marker files like `.installed`.
#[tauri::command]
pub fn write_server_file(app_handle: AppHandle, id: String, rel_path: String, content: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dirs: {e}"))?;
    }
    std::fs::write(&target, &content)
        .map_err(|e| format!("failed to write '{rel_path}': {e}"))
}

/// A single entry in a directory listing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Security: resolve a relative path against the instance root and reject
/// paths that escape the instance directory (path traversal prevention).
fn resolve_path(instance_root: &str, rel_path: &str) -> Result<std::path::PathBuf, String> {
    let root = std::path::Path::new(instance_root);
    // Normalize the relative path — strip leading `/` or `\`, reject absolute.
    let clean = rel_path
        .trim_start_matches('/')
        .trim_start_matches('\\');
    if std::path::Path::new(clean).is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    let joined = root.join(clean);
    // Canonicalize the root to resolve any `..` traversal, then ensure the
    // resolved target is still under the root.
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve instance path: {e}"))?;
    let target = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| format!("cannot resolve target path: {e}"))?
    } else {
        // For non-existent paths, resolve parent and check the joined path
        // is still under root by comparing components.
        joined
    };
    if !target.starts_with(&canonical_root) {
        return Err("path traversal detected".to_string());
    }
    Ok(target)
}

/// Reads a file's content from an instance's working directory.
#[tauri::command]
pub fn read_server_file(app_handle: AppHandle, id: String, rel_path: String) -> Result<String, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.is_file() {
        return Err(format!("'{}' is not a file or does not exist", rel_path));
    }
    std::fs::read_to_string(&target)
        .map_err(|e| format!("failed to read '{rel_path}': {e}"))
}

/// Lists the contents of a directory inside an instance's working directory.
/// Returns a sorted list of FileEntry values (directories first, then files).
#[tauri::command]
pub fn list_server_directory(app_handle: AppHandle, id: String, rel_path: String) -> Result<Vec<FileEntry>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.is_dir() {
        return Err(format!("'{}' is not a directory or does not exist", rel_path));
    }
    let mut entries: Vec<FileEntry> = std::fs::read_dir(&target)
        .map_err(|e| format!("failed to list directory '{rel_path}': {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata().ok()?;
            Some(FileEntry {
                name,
                is_dir: meta.is_dir(),
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            })
        })
        .collect();
    // Sort: directories first, then alphabetically within each group.
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir) // dirs first
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });
    Ok(entries)
}

/// Deletes a file or empty directory inside an instance's working directory.
/// Non-empty directories return an error — use a future recursive variant for that.
#[tauri::command]
pub fn delete_server_path(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.exists() {
        return Err(format!("'{}' does not exist", rel_path));
    }
    if target.is_dir() {
        // Only remove empty directories.
        let is_empty = target.read_dir().map_err(|e| format!("failed to read dir: {e}"))?.next().is_none();
        if !is_empty {
            return Err(format!("directory '{}' is not empty — delete files individually", rel_path));
        }
        std::fs::remove_dir(&target)
            .map_err(|e| format!("failed to remove directory '{rel_path}': {e}"))
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| format!("failed to remove file '{rel_path}': {e}"))
    }
}

/// Creates a directory (and any missing parents) inside an instance's working directory.
#[tauri::command]
pub fn create_server_directory(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if target.exists() {
        return Err(format!("'{}' already exists", rel_path));
    }
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("failed to create directory '{rel_path}': {e}"))
}

/// Renames (or moves) a file or directory inside an instance's working directory.
/// Both old_rel_path and new_rel_path are relative to the instance root.
#[tauri::command]
pub fn rename_server_path(app_handle: AppHandle, id: String, old_rel_path: String, new_rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let source = resolve_path(&instance.path, &old_rel_path)?;
    let dest = resolve_path(&instance.path, &new_rel_path)?;
    if !source.exists() {
        return Err(format!("source '{}' does not exist", old_rel_path));
    }
    if dest.exists() {
        return Err(format!("destination '{}' already exists", new_rel_path));
    }
    // Create parent directories for the destination if needed.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dirs: {e}"))?;
    }
    std::fs::rename(&source, &dest)
        .map_err(|e| format!("failed to rename '{}' -> '{}': {e}", old_rel_path, new_rel_path))
}

/// Lists every installed community plugin (manifest), sorted by id.
#[tauri::command]
pub fn list_plugins(app_handle: AppHandle) -> Result<Vec<manifest::Manifest>, String> {
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    Ok(manifest::discover(&plugins_dir))
}

/// Loads a single plugin manifest by id.
#[tauri::command]
pub fn get_plugin(
    app_handle: AppHandle,
    id: String,
) -> Result<manifest::Manifest, String> {
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    manifest::load_by_id(&plugins_dir, &id)
}

/// Returns the absolute path to a plugin's UI entry bundle, if the plugin
/// declares one. Used by the frontend to build an asset:// URL for Shadow DOM
/// mounting (ArchitecturePlan §4, PluginWrapper).
#[tauri::command]
pub fn get_plugin_ui_path(app_handle: AppHandle, id: String) -> Result<Option<String>, String> {
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    let plugin_dir = plugins_dir.join(&id);
    let manifest = manifest::load_by_id(&plugins_dir, &id)?;
    match manifest.ui_entry {
        Some(entry) if !entry.is_empty() => {
            Ok(Some(plugin_dir.join(entry).to_string_lossy().to_string()))
        }
        _ => Ok(None),
    }
}

/// Copies a plugin directory (containing manifest.json) into the host's
/// plugin directory at `<app_data>/plugins/<id>/`.
///
/// The `source_path` should point at the plugin directory (or any file within
/// it — the parent directory is used). Returns the installed manifest on
/// success, or an error if the manifest is missing/invalid or a plugin with
/// the same id is already installed.
#[tauri::command]
pub fn install_plugin(
    app_handle: AppHandle,
    source_path: String,
) -> Result<manifest::Manifest, String> {
    let src = std::path::Path::new(&source_path);
    // If the user picked a file (manifest.json), use its parent directory.
    let plugin_dir = if src.is_file() {
        src.parent().ok_or_else(|| "could not resolve plugin directory".to_string())?
    } else {
        src
    };

    // Validate the manifest before copying anything.
    let manifest_path = plugin_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!(
            "'{}' does not contain a manifest.json",
            plugin_dir.display()
        ));
    }
    let manifest = manifest::load(&manifest_path)?;

    // Check for id collision.
    let base = config::config_dir(&app_handle)?;
    let plugins_target = manifest::plugins_dir(&base);
    let target = plugins_target.join(&manifest.id);
    if target.exists() {
        return Err(format!(
            "plugin '{}' is already installed — uninstall it first",
            manifest.id
        ));
    }

    // Copy the entire plugin directory into the target.
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("failed to create plugin directory: {e}"))?;
    copy_dir_recursive(plugin_dir, &target).map_err(|e| {
        // Best-effort cleanup on failure.
        let _ = std::fs::remove_dir_all(&target);
        format!("failed to copy plugin directory: {e}")
    })?;

    Ok(manifest)
}

/// Recursively copies a directory tree. Used here for plugin installation
/// instead of pulling a crate for this one-shot operation.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_dir_recursive(&from, &to)?;
            } else {
                std::fs::copy(&from, &to)?;
            }
        }
    }
    Ok(())
}

/// Removes an installed plugin by id from the host's plugin directory.
///
/// Returns an error if the plugin is not found, or if any registered server
/// instance still references it. The caller should confirm before calling.
#[tauri::command]
pub fn uninstall_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    let target = plugins_dir.join(&id);

    if !target.exists() {
        return Err(format!("plugin '{id}' is not installed"));
    }

    // Check for server instances that depend on this plugin.
    let cfg = config::load_config(&app_handle)?;
    let dependents: Vec<&str> = cfg
        .servers
        .values()
        .filter(|s| s.server_type == id)
        .map(|s| s.name.as_str())
        .collect();
    if !dependents.is_empty() {
        return Err(format!(
            "cannot uninstall '{id}' — {} server instance(s) still reference it: {}",
            dependents.len(),
            dependents.join(", ")
        ));
    }

    std::fs::remove_dir_all(&target)
        .map_err(|e| format!("failed to remove plugin '{id}': {e}"))
}
