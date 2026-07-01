//! Tauri commands exposing the server registry CRUD + process lifecycle.
//!
//! Spec: documentation/ArchitecturePlan.md §2 (Phase 1 — standard CRUD
//! operations via Rust file commands, plus orphaned-state handling) and
//! §5 (Phase 2 — variable process lifecycle execution + log streaming).

use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use tauri::{AppHandle, Manager};

use crate::config::{self, AppConfig, ServerInstance};
use crate::manifest;
use crate::metrics::{InstanceMetrics, MetricsState};
use crate::process;
use crate::scaffold;

/// How long to wait for a graceful shutdown before falling back to a hard kill.
///
/// 15s comfortably covers a Minecraft world save on typical hardware (chunk
/// flush + level.dat write), while still bounding the wait if the process is
/// hung or unresponsive — so the stop button never gets stuck.
const GRACEFUL_STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

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

    // ── Smart JAR / script detection for start steps ───────────────────
    // For "start" lifecycle steps, resolve which JAR (or launch script)
    // exists on disk and inject it into the overrides so the manifest
    // template {{userOverrides.server_jar}} resolves to a real filename.
    // For shell-based steps (Forge/NeoForge), detect the actual script
    // (run.sh, start.sh, etc.) and inject its extension-less name so
    // build_shell_command resolves it to the platform-appropriate extension.
    let mut overrides = instance.user_overrides.clone();
    if step_name == "start" {
        let root = std::path::Path::new(&instance.path);

        // Check if the user has set a custom jar / script name.
        let custom_jar = overrides.get("server_jar").map(String::as_str).unwrap_or("").trim();
        if !custom_jar.is_empty() {
            // User specified a custom name — validate it exists.
            if !root.join(custom_jar).exists() {
                set_status(app_handle, id, "error")?;
                return Err(format!(
                    "Server JAR not found: '{custom_jar}'. Check the name in Settings > Server JAR."
                ));
            }
            if step.use_shell {
                // For shell steps, strip the extension so build_shell_command
                // can resolve it to the platform-appropriate extension.
                let bare = strip_script_extension(custom_jar);
                overrides.insert("server_jar".to_string(), bare);
            } else {
                overrides.insert("server_jar".to_string(), custom_jar.to_string());
            }
        } else if step.use_shell {
            // Shell-based step (Forge/NeoForge): detect which script exists.
            // Try in priority order: kern_start (installer-generated), run, start.
            // Strip the extension so build_shell_command adds the right one.
            let detected = detect_script_for_launch(root);
            match detected {
                Some(name) => {
                    let bare = strip_script_extension(&name);
                    overrides.insert("server_jar".to_string(), bare);
                }
                None => {
                    set_status(app_handle, id, "error")?;
                    return Err(
                        "Forge/NeoForge launch scripts not found (run.sh/start.sh). Run 'install' first, or set a custom script name in Settings > Server JAR.".to_string()
                    );
                }
            }
        } else {
            // JAR-based step: auto-detect in priority order.
            let detected = detect_jar_for_launch(root, runtime.unwrap_or("purpur"));
            match detected {
                Some(name) => {
                    overrides.insert("server_jar".to_string(), name);
                }
                None => {
                    set_status(app_handle, id, "error")?;
                    return Err(
                        "Server JAR not found. Run 'install' first, or set a custom JAR name in settings.".to_string()
                    );
                }
            }
        }
    }

    let command = process::resolve_variables(&step.command, &overrides);
    // Each manifest arg entry is templated, then shell-split so that a single
    // entry like "{{userOverrides.jvm_args}}" (which expands to many -XX flags)
    // becomes individual process arguments instead of one giant quoted string.
    let args: Vec<String> = step
        .args
        .iter()
        .flat_map(|a| process::shell_split(&process::resolve_variables(a, &overrides)))
        .collect();

    // Set a transient status like "starting", "installing", etc.
    let transient = format!("{step_name}-ing");
    set_status(app_handle, id, &transient)?;

    // The Setup-selected JDK, read from the live overrides (the value the user
    // sees on the Setup page) rather than the possibly-stale `.env` file. Passed
    // explicitly so shell-based steps (Forge/NeoForge) derive the right
    // JAVA_HOME / PATH for the same JDK.
    let java_path = overrides.get("java_path").map(String::as_str);

    if let Err(e) = process::launch(
        app_handle,
        id,
        std::path::Path::new(&instance.path),
        &command,
        &args,
        step.use_shell,
        java_path,
    ) {
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

/// Strips the extension from a script filename so `build_shell_command` can
/// resolve it to the platform-appropriate extension (.bat on Windows, .sh on
/// Unix). E.g. "run.sh" → "run", "start.bat" → "start", "kern_start" → "kern_start".
fn strip_script_extension(name: &str) -> String {
    if let Some(stem) = name.strip_suffix(".sh") {
        stem.to_string()
    } else if let Some(stem) = name.strip_suffix(".bat") {
        stem.to_string()
    } else {
        name.to_string()
    }
}

/// Detects which launch script exists for Forge/NeoForge. Checks in priority
/// order: kern_start (installer-generated), run, start. Returns the full
/// filename (with extension) of the first match.
fn detect_script_for_launch(root: &std::path::Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    let candidates = ["kern_start.bat", "run.bat", "start.bat"];
    #[cfg(not(target_os = "windows"))]
    let candidates = ["kern_start.sh", "run.sh", "start.sh"];

    for name in &candidates {
        if root.join(name).exists() {
            return Some(name.to_string());
        }
    }
    None
}

/// Lightweight jar / script detection for pre-launch validation. Checks common
/// names in priority order based on the runtime. Returns the first filename
/// that exists on disk, or None if nothing is found.
fn detect_jar_for_launch(root: &std::path::Path, runtime: &str) -> Option<String> {
    // Priority 1: server.jar (Vanilla, Paper, Purpur — and commonly used by all)
    if root.join("server.jar").exists() {
        return Some("server.jar".to_string());
    }

    // Priority 2: runtime-specific jars or launch scripts
    match runtime {
        "fabric" => {
            if root.join("fabric-server-launch.jar").exists() {
                return Some("fabric-server-launch.jar".to_string());
            }
        }
        "quilt" => {
            if root.join("quilt-server-launcher.jar").exists() {
                return Some("quilt-server-launcher.jar".to_string());
            }
        }
        "forge" | "neoforge" => {
            // Forge/NeoForge use generated run scripts, not -jar.
            #[cfg(target_os = "windows")]
            {
                for name in &["run.bat", "start.bat", "kern_start.bat"] {
                    if root.join(name).exists() {
                        return Some(name.to_string());
                    }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                for name in &["run.sh", "start.sh", "kern_start.sh"] {
                    if root.join(name).exists() {
                        return Some(name.to_string());
                    }
                }
            }
        }
        _ => {}
    }

    // Priority 3: scan for any *.jar (excluding installer/library jars)
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut fallbacks: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jar") {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if name.ends_with("-installer.jar")
                    || name.ends_with("-libraries.jar")
                    || name.contains("installer")
                {
                    continue;
                }
                fallbacks.push(name);
            }
        }
        fallbacks.sort();
        if let Some(first) = fallbacks.into_iter().next() {
            return Some(first);
        }
    }

    None
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

    // Graceful: let the server save its world before we tear it down. Falls back
    // to a hard kill if it doesn't exit within the timeout, so a restart can
    // never hang. The subsequent pause + relaunch then start clean.
    process::stop_graceful(&app_handle, &id, GRACEFUL_STOP_TIMEOUT)?;

    // Brief pause lets the OS release resources before re-spawning.
    std::thread::sleep(std::time::Duration::from_millis(300));

    run_step(&app_handle, &id, "start")
}

/// Stops a running instance. Idempotent — Ok if it wasn't running.
///
/// Asks the server to shut down gracefully first (e.g. Minecraft's `stop`
/// command flushes chunks and saves the world), and only hard-kills if it
/// hasn't exited within [`GRACEFUL_STOP_TIMEOUT`]. This avoids rollbacks to the
/// last autosave that a raw process kill would cause.
#[tauri::command]
pub fn stop_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    set_status(&app_handle, &id, "stopping")?;
    process::stop_graceful(&app_handle, &id, GRACEFUL_STOP_TIMEOUT)?;
    set_status(&app_handle, &id, "stopped")?;
    Ok(())
}

/// Runs an arbitrary command inside an instance's working directory and waits
/// for it to complete. All stdout/stderr is streamed to `log:<id>:stream`
/// events and appended to `latest.log`, exactly like a lifecycle step.
///
/// This is a synchronous (blocking) command — the frontend awaits it. It's
/// designed for one-shot setup tasks such as running Fabric/Forge installers,
/// or any plugin-driven installation step that needs to run a process and
/// see its output in the terminal.
///
/// The process inherits the instance's `.env` environment variables. On
/// failure the persisted status is set to "error" before the error is returned.
#[tauri::command]
pub fn run_instance_command(
    app_handle: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command as StdCommand, Stdio};
    use tauri::Emitter;

    // 1. Load instance config.
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?
        .clone();
    if instance.is_orphaned {
        return Err(format!(
            "instance '{id}' is orphaned (path missing): {}",
            instance.path
        ));
    }

    let working_dir = std::path::Path::new(&instance.path);
    let log_path = working_dir.join("latest.log");

    // 2. Build the command.
    let mut cmd = StdCommand::new(&command);
    cmd.current_dir(working_dir);
    cmd.args(&args);
    // Inherit host env and layer the instance's .env on top.
    let env_path = working_dir.join(".env");
    for (k, v) in parse_env_file(&env_path) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 3. Set transient status.
    set_status(&app_handle, &id, "setup")?;

    // 4. Spawn.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{command}': {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned child has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "spawned child has no stderr pipe".to_string())?;

    let event_name = format!("log:{id}:stream");

    // 5. Read stdout and stderr concurrently using threads, forward to log.
    //    We merge them into a single stream (same as the lifecycle process).
    let handle = app_handle.clone();
    let log_path_stdout = log_path.clone();
    let event_out = event_name.clone();
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let stamped = forward_to_log(&handle, &event_out, &log_path_stdout, &line);
            let _ = handle.emit(&event_out, stamped);
        }
    });

    let handle_err = app_handle.clone();
    let log_path_stderr = log_path.clone();
    let event_err = event_name.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let stamped = forward_to_log(&handle_err, &event_err, &log_path_stderr, &line);
            let _ = handle_err.emit(&event_err, stamped);
        }
    });

    // 6. Wait for both readers to finish, then wait for the child to exit.
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for child: {e}"))?;

    // 7. Report result.
    if status.success() {
        set_status(&app_handle, &id, "stopped")?;
        Ok(())
    } else {
        let code = status.code().map_or("unknown".to_string(), |c| c.to_string());
        set_status(&app_handle, &id, "error")?;
        Err(format!("command exited with code {code}"))
    }
}

/// Formats the current wall-clock time as `[HH:MM:SS]`.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut tod = secs % 86_400;
    let h = (tod / 3600) % 24;
    tod %= 3600;
    let m = (tod / 60) % 60;
    let s = tod % 60;
    format!("[{h:02}:{m:02}:{s:02}]")
}

/// Returns true if `line` already starts with a `[HH:MM:SS]`-style timestamp.
///
/// Mirrors process::has_timestamp — keeps the in-memory view in step with what
/// lands on disk so emulated console timestamps never double up.
//
// See process.rs — the optional second hour digit triggers a false positive
// `unused_assignments` warning; suppressed at function level since `i` is
// read by the subsequent `'':'` check in every branch that reaches here.
#[allow(unused_assignments)]
fn has_timestamp(line: &str) -> bool {
    use std::ops::ControlFlow;

    fn digits(bytes: &[u8], i: &mut usize, n: usize) -> ControlFlow<(), ()> {
        for _ in 0..n {
            if *i >= bytes.len() || !bytes[*i].is_ascii_digit() {
                return ControlFlow::Break(());
            }
            *i += 1;
        }
        ControlFlow::Continue(())
    }

    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < len && bytes[i] == b'[' {
        i += 1;
    }
    if digits(bytes, &mut i, 1).is_break() {
        return false;
    }
    if i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= len || bytes[i] != b':' || digits(&bytes, &mut i, 2).is_break() {
        return false;
    }
    if i < len && bytes[i] == b':' {
        if digits(&bytes, &mut i, 2).is_break() {
            return false;
        }
    }
    if i < len && bytes[i] == b'.' {
        i += 1;
        if digits(&bytes, &mut i, 1).is_break() {
            return false;
        }
        while i < len && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if matches!(bytes.get(i), Some(b) if *b == b'a' || *b == b'A' || *b == b'p' || *b == b'P')
        && matches!(bytes.get(i + 1), Some(b) if *b == b'm' || *b == b'M')
    {
        i += 2;
    } else if matches!(bytes.get(i), Some(b) if *b == b'm' || *b == b'M') {
        i += 1;
    }
    if i < len && bytes[i] == b']' {
        i += 1;
    }
    true
}

/// Appends a line to latest.log and returns a timestamped string for the event.
fn forward_to_log(_handle: &AppHandle, _event_name: &str, log_path: &std::path::Path, line: &str) -> String {
    let stamped = if has_timestamp(line) {
        line.to_string()
    } else {
        let ts = timestamp();
        format!("{ts} {line}")
    };
    // Write to latest.log (best-effort).
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{stamped}");
    }
    stamped
}

/// Parses a `.env` file into (key, value) pairs. Mirrors process.rs logic.
fn parse_env_file(path: &std::path::Path) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut val = val.trim().to_string();
        let bytes = val.as_bytes();
        if bytes.len() >= 2
            && (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'
                || bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
        {
            val = val[1..val.len() - 1].to_string();
        }
        out.push((key.to_string(), val));
    }
    out
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

/// Deletes a file or directory recursively inside an instance's working directory.
/// Unlike `delete_server_path`, this removes non-empty directories and all their
/// contents — use with caution.
#[tauri::command]
pub fn delete_server_path_recursive(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
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
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("failed to remove directory '{rel_path}': {e}"))
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| format!("failed to remove file '{rel_path}': {e}"))
    }
}

/// Opens a file or directory inside an instance in the system file manager
/// (Windows Explorer, macOS Finder, Linux xdg-open).
/// If the path is a file, its parent directory is opened with the file selected
/// where possible; if it's a directory, the directory itself is opened.
#[tauri::command]
pub fn open_server_path(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.exists() {
        return Err(format!("'{}' does not exist", rel_path));
    }
    let path_to_open = if target.is_file() {
        // Open the parent directory with the file highlighted where possible.
        target.parent().unwrap_or(&target).to_path_buf()
    } else {
        target
    };
    open::that(&path_to_open)
        .map_err(|e| format!("failed to open '{}': {e}", path_to_open.display()))
}

/// Copies one or more files from absolute source paths into a target directory
/// inside an instance's working directory. Used for drag-and-drop from the OS
/// file manager — the frontend passes the dropped file paths here.
#[tauri::command]
pub fn copy_files_to_server(
    app_handle: AppHandle,
    id: String,
    source_paths: Vec<String>,
    target_rel_path: String,
) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target_dir = resolve_path(&instance.path, &target_rel_path)?;

    for source in &source_paths {
        let source_path = std::path::Path::new(source);
        if !source_path.exists() {
            return Err(format!("source path '{}' does not exist", source));
        }
        let file_name = source_path
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source))?;
        let dest = target_dir.join(file_name);

        std::fs::copy(source_path, &dest)
            .map_err(|e| format!("failed to copy '{}': {}", source, e))?;
    }
    Ok(())
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
///
/// If `upgrade` is true and the plugin exists, it will be removed to allow
/// a fresh install (used by .kern package upgrades).
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

// ---------------------------------------------------------------------------
// .kern file support (plugin packages)
// ---------------------------------------------------------------------------

/// Validates a .kern file and returns its manifest without installing.
/// Used to preview plugin info before installation.
#[tauri::command]
pub fn validate_kern_file(path: String) -> Result<manifest::Manifest, String> {
    let p = std::path::Path::new(&path);

    // Check file extension
    if p.extension().and_then(|e| e.to_str()) != Some("kern") {
        return Err(format!(
            "file '{}' is not a .kern file",
            p.display()
        ));
    }

    if !p.exists() {
        return Err(format!("file '{}' does not exist", p.display()));
    }

    // Extract manifest from the .kern (zip) archive to a temp directory
    let temp_dir = tempfile::tempdir()
        .map_err(|e| format!("failed to create temp directory: {e}"))?;

    extract_kern_archive(p, temp_dir.path())?;

    // Load and validate manifest
    let manifest_path = temp_dir.path().join("manifest.json");
    if !manifest_path.exists() {
        return Err("plugin package does not contain a manifest.json".to_string());
    }

    manifest::load(&manifest_path)
}

/// Installs a plugin from a .kern file.
/// If a plugin with the same id exists, sets `force` to true to upgrade/reinstall.
#[tauri::command]
pub fn install_plugin_from_kern(
    app_handle: AppHandle,
    source_path: String,
    force: bool,
) -> Result<manifest::Manifest, String> {
    let p = std::path::Path::new(&source_path);

    // Validate it's a .kern file
    if p.extension().and_then(|e| e.to_str()) != Some("kern") {
        return Err(format!(
            "file '{}' is not a .kern file",
            p.display()
        ));
    }

    if !p.exists() {
        return Err(format!("file '{}' does not exist", p.display()));
    }

    // Extract to temp directory
    let temp_dir = tempfile::tempdir()
        .map_err(|e| format!("failed to create temp directory: {e}"))?;

    extract_kern_archive(p, temp_dir.path())?;

    // Load and validate manifest
    let manifest_path = temp_dir.path().join("manifest.json");
    if !manifest_path.exists() {
        return Err("plugin package does not contain a manifest.json".to_string());
    }
    let manifest = manifest::load(&manifest_path)?;

    let base = config::config_dir(&app_handle)?;
    let plugins_target = manifest::plugins_dir(&base);
    let target = plugins_target.join(&manifest.id);

    // Check for existing plugin - upgrade if force is true
    if target.exists() {
        if !force {
            return Err(format!(
                "plugin '{}' is already installed — uninstall it first or use force=true to upgrade",
                manifest.id
            ));
        }
        // Remove existing plugin for upgrade
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("failed to remove existing plugin '{}': {e}", manifest.id))?;
    }

    // Copy extracted plugin to plugins directory
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("failed to create plugin directory: {e}"))?;

    copy_dir_recursive(temp_dir.path(), &target).map_err(|e| {
        let _ = std::fs::remove_dir_all(&target);
        format!("failed to copy plugin directory: {e}")
    })?;

    Ok(manifest)
}

/// Creates a .kern package from a plugin directory.
/// Useful for plugin developers to package their plugins.
#[tauri::command]
pub fn create_plugin_package(
    source_path: String,
    output_path: Option<String>,
) -> Result<String, String> {
    let p = std::path::Path::new(&source_path);

    // Validate source directory exists
    if !p.is_dir() {
        return Err(format!(
            "source path '{}' is not a directory",
            p.display()
        ));
    }

    // Validate manifest exists in source
    let manifest_path = p.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!(
            "source directory '{}' does not contain a manifest.json",
            p.display()
        ));
    }

    // Determine output path
    let output = match output_path {
        Some(op) => std::path::Path::new(&op).to_path_buf(),
        None => {
            // Use source directory with .kern extension
            // Name: <plugin-id>.kern (no version in filename)
            let manifest: manifest::Manifest = manifest::load(&manifest_path)?;
            p.join(format!("{}.kern", manifest.id))
        }
    };

    // Create the zip archive
    let file = std::fs::File::create(&output)
        .map_err(|e| format!("failed to create output file: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut buffer = Vec::new();
    add_dir_to_zip(&mut zip, p, p, &mut buffer, options)
        .map_err(|e| format!("failed to create package: {e}"))?;

    zip.finish()
        .map_err(|e| format!("failed to finalize package: {e}"))?;

    Ok(output.to_string_lossy().to_string())
}

/// Recursively adds a directory to a zip archive.
fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    base: &std::path::Path,
    current: &std::path::Path,
    buffer: &mut Vec<u8>,
    options: zip::write::FileOptions<()>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(current)
        .map_err(|e| e.to_string())?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(base).unwrap_or(&path);

        if path.is_dir() {
            zip.add_directory(relative.to_string_lossy(), options)
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, base, &path, buffer, options)?;
        } else {
            zip.start_file(relative.to_string_lossy(), options)
                .map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(&path)
                .map_err(|e| e.to_string())?;
            f.read_to_end(buffer)
                .map_err(|e| e.to_string())?;
            zip.write_all(buffer)
                .map_err(|e| e.to_string())?;
            buffer.clear();
        }
    }
    Ok(())
}

/// Extracts a .kern (zip) archive to the specified destination.
fn extract_kern_archive(archive_path: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    use std::io::Read;

    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("failed to open .kern file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("invalid .kern archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("failed to read archive entry: {e}"))?;
        let outpath = dst.join(file.name());

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("failed to create directory: {e}"))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create parent dir: {e}"))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("failed to create file: {e}"))?;
            let mut content = Vec::new();
            file.read_to_end(&mut content)
                .map_err(|e| format!("failed to read archive: {e}"))?;
            outfile.write_all(&content)
                .map_err(|e| format!("failed to write file: {e}"))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// World backup & restore
// ---------------------------------------------------------------------------

/// Zips the `world/` directory (and its Nether/End variants if present) into a
/// timestamped archive under `backups/`. Returns the created archive's relative
/// path. The world is backed up live — no server stop required — but the user
/// should ideally run `save-all` first to flush chunk data to disk.
#[tauri::command]
pub fn backup_world(app_handle: AppHandle, id: String) -> Result<String, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let root = PathBuf::from(&instance.path);
    let world_dir = root.join("world");

    if !world_dir.exists() {
        return Err(format!(
            "no world directory found at '{}' — the server may not have been started yet",
            world_dir.display()
        ));
    }

    // Ensure the backups/ directory exists.
    let backups_dir = root.join("backups");
    std::fs::create_dir_all(&backups_dir)
        .map_err(|e| format!("failed to create backups dir: {e}"))?;

    // Timestamped archive name: world-2026-06-30T14-30-00.zip
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let archive_name = format!("world-{}.zip", timestamp);
    let archive_path = backups_dir.join(&archive_name);

    // Create the zip archive, walking the world directory tree.
    let file = std::fs::File::create(&archive_path)
        .map_err(|e| format!("failed to create archive: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut buffer = Vec::new();
    let world_prefix = world_dir.clone();

    for entry in WalkDir::new(&world_dir) {
        let entry = entry.map_err(|e| format!("walk error: {e}"))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(&world_prefix)
            .map_err(|e| format!("path strip error: {e}"))?;

        if path.is_dir() {
            zip.add_directory(relative.to_string_lossy(), options)
                .map_err(|e| format!("zip add dir error: {e}"))?;
        } else {
            zip.start_file(relative.to_string_lossy(), options)
                .map_err(|e| format!("zip start file error: {e}"))?;
            let mut f = std::fs::File::open(path)
                .map_err(|e| format!("open file error: {e}"))?;
            f.read_to_end(&mut buffer)
                .map_err(|e| format!("read error: {e}"))?;
            zip.write_all(&buffer)
                .map_err(|e| format!("zip write error: {e}"))?;
            buffer.clear();
        }
    }

    zip.finish().map_err(|e| format!("zip finalize error: {e}"))?;

    Ok(format!("backups/{}", archive_name))
}

/// Lists existing world backups as { name, size } pairs, newest first.
#[tauri::command]
pub fn list_backups(app_handle: AppHandle, id: String) -> Result<Vec<serde_json::Value>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let backups_dir = PathBuf::from(&instance.path).join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    for entry in std::fs::read_dir(&backups_dir)
        .map_err(|e| format!("read backups dir error: {e}"))?
    {
        let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(serde_json::json!({ "name": name, "size": size }));
    }

    entries.sort_by(|a, b| {
        let a_name = a["name"].as_str().unwrap_or("");
        let b_name = b["name"].as_str().unwrap_or("");
        b_name.cmp(a_name) // newest first
    });

    Ok(entries)
}

/// Restores a world from a backup archive. Backs up the current world first
/// (safety copy), then replaces `world/` contents with the archive's contents.
#[tauri::command]
pub fn restore_world(
    app_handle: AppHandle,
    id: String,
    backup_name: String,
) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let root = PathBuf::from(&instance.path);
    let backups_dir = root.join("backups");
    let archive_path = backups_dir.join(&backup_name);

    if !archive_path.exists() {
        return Err(format!("backup '{}' not found", backup_name));
    }

    let world_dir = root.join("world");

    // Safety: if a current world exists, create a pre-restore snapshot first.
    if world_dir.exists() {
        let safety_name = format!(
            "pre-restore-{}.zip",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        );
        let safety_path = backups_dir.join(&safety_name);

        let file = std::fs::File::create(&safety_path)
            .map_err(|e| format!("failed to create safety backup: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut buffer = Vec::new();

        for entry in WalkDir::new(&world_dir) {
            let entry = entry.map_err(|e| format!("walk error: {e}"))?;
            let path = entry.path();
            let relative = path.strip_prefix(&world_dir).unwrap();
            if path.is_dir() {
                zip.add_directory(relative.to_string_lossy(), options)
                    .map_err(|e| format!("zip error: {e}"))?;
            } else {
                zip.start_file(relative.to_string_lossy(), options)
                    .map_err(|e| format!("zip error: {e}"))?;
                let mut f = std::fs::File::open(path).map_err(|e| format!("read error: {e}"))?;
                    f.read_to_end(&mut buffer).map_err(|e| format!("read error: {e}"))?;
                zip.write_all(&buffer).map_err(|e| format!("zip error: {e}"))?;
                buffer.clear();
            }
        }
        zip.finish().map_err(|e| format!("zip error: {e}"))?;

        // Remove the old world directory.
        std::fs::remove_dir_all(&world_dir)
            .map_err(|e| format!("failed to remove old world: {e}"))?;
    }

    // Extract the archive into a fresh world/ directory.
    std::fs::create_dir_all(&world_dir)
        .map_err(|e| format!("failed to create world dir: {e}"))?;

    let archive_file = std::fs::File::open(&archive_path)
        .map_err(|e| format!("failed to open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|e| format!("failed to read archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("archive error: {e}"))?;
        let outpath = world_dir.join(file.name());

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("mkdir error: {e}"))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir error: {e}"))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("create file error: {e}"))?;
            let mut content = Vec::new();
            file.read_to_end(&mut content).map_err(|e| format!("read error: {e}"))?;
            outfile.write_all(&content).map_err(|e| format!("write error: {e}"))?;
        }
    }

    Ok(())
}

/// Deletes a backup archive from disk.
#[tauri::command]
pub fn delete_backup(
    app_handle: AppHandle,
    id: String,
    backup_name: String,
) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let archive_path = PathBuf::from(&instance.path)
        .join("backups")
        .join(&backup_name);

    if !archive_path.exists() {
        return Err(format!("backup '{}' not found", backup_name));
    }

    std::fs::remove_file(&archive_path)
        .map_err(|e| format!("failed to delete backup: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Smart JAR detection
// ---------------------------------------------------------------------------

/// Result of server JAR auto-detection.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarDetectionResult {
    /// The filename that was found (or the user-specified one).
    pub detected_jar: Option<String>,
    /// Whether the resolved file actually exists on disk.
    pub exists: bool,
    /// All candidate filenames that were checked, in priority order.
    pub candidates: Vec<String>,
    /// Human-readable explanation of what happened.
    pub message: String,
}

/// Detects which server JAR (or launch script) exists in the instance directory.
///
/// Priority order:
///   1. User-specified `server_jar` override (if non-empty)
///   2. `server.jar` — produced by Vanilla, Paper, Purpur
///   3. `fabric-server-launch.jar` — Fabric
///   4. `quilt-server-launcher.jar` — Quilt
///   5. `run.sh` / `run.bat` — Forge / NeoForge generated scripts
///   6. Any `*.jar` in the root (excluding installer/library jars)
///
/// Returns a structured result so the frontend can display status without
/// needing to duplicate the detection logic.
#[tauri::command]
pub fn detect_server_jar(app_handle: AppHandle, id: String) -> Result<JarDetectionResult, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let root = std::path::Path::new(&instance.path);
    let runtime = instance.user_overrides.get("runtime").map(String::as_str).unwrap_or("purpur");

    // If the user explicitly set a jar name, just check that one.
    if let Some(custom) = instance.user_overrides.get("server_jar") {
        let custom = custom.trim();
        if !custom.is_empty() {
            let exists = root.join(custom).exists();
            return Ok(JarDetectionResult {
                detected_jar: Some(custom.to_string()),
                exists,
                candidates: vec![custom.to_string()],
                message: if exists {
                    format!("Using custom JAR: {custom}")
                } else {
                    format!("Custom JAR not found: {custom}")
                },
            });
        }
    }

    // Build the candidate list based on runtime.
    let mut candidates: Vec<String> = vec!["server.jar".to_string()];
    match runtime {
        "fabric" => candidates.push("fabric-server-launch.jar".to_string()),
        "quilt" => candidates.push("quilt-server-launcher.jar".to_string()),
        "forge" | "neoforge" => {
            // Forge/NeoForge don't use -jar; they use generated run scripts.
            #[cfg(target_os = "windows")]
            {
                candidates.push("kern_start.bat".to_string());
                candidates.push("run.bat".to_string());
                candidates.push("start.bat".to_string());
            }
            #[cfg(not(target_os = "windows"))]
            {
                candidates.push("kern_start.sh".to_string());
                candidates.push("run.sh".to_string());
                candidates.push("start.sh".to_string());
            }
        }
        _ => {
            // Vanilla/Paper/Purpur already have server.jar; add common alternatives.
        }
    }

    // Check each candidate in order.
    for name in &candidates {
        if root.join(name).exists() {
            let found = name.clone();
            return Ok(JarDetectionResult {
                detected_jar: Some(found.clone()),
                exists: true,
                candidates,
                message: format!("Found: {found}"),
            });
        }
    }

    // Final fallback: scan for any *.jar (excluding installers and libraries).
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut fallbacks: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jar") {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                // Skip installer jars and anything in subdirectories.
                if name.ends_with("-installer.jar")
                    || name.ends_with("-libraries.jar")
                    || name.contains("installer")
                {
                    continue;
                }
                fallbacks.push(name);
            }
        }
        // Sort alphabetically so the result is deterministic.
        fallbacks.sort();
        if let Some(first) = fallbacks.first() {
            candidates.push(first.clone());
            return Ok(JarDetectionResult {
                detected_jar: Some(first.clone()),
                exists: true,
                candidates,
                message: format!("Found: {first}"),
            });
        }
    }

    Ok(JarDetectionResult {
        detected_jar: None,
        exists: false,
        candidates,
        message: "No server JAR found. Run 'install' first, or set a custom JAR name in settings.".to_string(),
    })
}
