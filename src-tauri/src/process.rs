//! Running-process registry + variable resolution.
//!
//! Spec: documentation/ArchitecturePlan.md §5 (Backend Architecture).
//!
//! Processes are spawned with `std::process::Command` using piped stdio. Output
//! is read on two dedicated blocking threads (stdout + stderr), each forwarding
//! line-by-line to the UI over `log:<id>:stream` and appending to
//! `latest.log`. State transitions (`Running` / `Exited`) go over `status:<id>`.
//!
//! Pipes (not a PTY) are used deliberately: most runtimes line-buffer when
//! writing to stdout regardless of whether it's a TTY — Rust's `std::io::stdout`
//! is a `LineWriter` that flushes on every `\n` unconditionally
//! (rust-lang/rust#60673), Python's `print` is line-buffered on a pipe, and
//! Node/Bun/Deno flush promptly. So output streams live without the complexity
//! and Windows-ConPTY flakiness of a pseudo-terminal.
//!
//! A per-instance generation tag lets a superseded reader self-suppress its
//! termination marker (so a fast restart emits exactly one).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

/// Structured status payload emitted on `status:<id>` — the UI can switch on
/// `state` rather than parsing a free-form string.
///
/// Serializes internally-tagged so it matches the frontend's discriminated-union
/// contract exactly: `Running` → `{ "state": "running" }` and
/// `Exited { code }` → `{ "state": "exited", "code": <n|null> }`. Without
/// `tag = "state"` serde uses the default externally-tagged form, which emits a
/// bare `"running"` string — and the UI's `payload.state === "running"` check
/// then never matches, so live status updates silently never fire.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum StatusPayload {
    /// Process spawned and now streaming output.
    Running,
    /// Process terminated, optionally with an exit code.
    Exited { code: Option<i32> },
}

/// One entry per running instance: the child (for kill + exit code), a writer
/// to feed its stdin, and the path to its working directory (for the log file).
///
/// Each entry is stamped with a generation at spawn time; the reader threads
/// capture that generation and only emit their termination marker if the
/// generation still matches the registry — so a stale/superseded task (from a
/// fast restart, where stop kills the child but the old readers aren't finished
/// before a new launch bumps the generation) self-suppresses and the marker is
/// emitted exactly once by the current task.
struct RunningProcess {
    /// The child handle. Locked because `stop()` (kill) and the reader thread
    /// (wait) both touch it. One writer at a time.
    child: Mutex<Child>,
    /// stdin writer. Mutex'd because `write_stdin` is called from a Tauri
    /// command thread.
    stdin: Mutex<Option<ChildStdin>>,
    /// OS process id, captured at spawn so the metrics sampler can resolve the
    /// process tree without locking the `Child` handle.
    pid: u32,
    #[allow(dead_code)]
    working_dir: PathBuf,
}

/// Global process table, keyed by server instance id, plus a per-instance
/// generation sequence used to stale-check background tasks.
#[derive(Default)]
pub struct ProcessRegistry {
    processes: Mutex<HashMap<String, RunningProcess>>,
    /// Per-instance_id generation counter. Increased every time a new process
    /// is registered for an id; the live value is stamped onto the RunningProcess
    /// and captured by its background task.
    generations: Mutex<HashMap<String, u64>>,
}

impl ProcessRegistry {
    /// Returns the next generation for the given instance id and records it as
    /// the current one. Only takes the generations mutex — callers that also
    /// need the processes map take that lock separately afterwards (never the
    /// other way around) to keep lock ordering deadlock-free.
    fn next_generation(&self, id: &str) -> u64 {
        let mut gens = self.generations.lock().expect("generations lock poisoned");
        let next = gens.get(id).copied().unwrap_or(0) + 1;
        gens.insert(id.to_string(), next);
        next
    }

    /// Returns the current stored generation for an id, if any.
    fn current_generation(&self, id: &str) -> Option<u64> {
        self.generations.lock().ok()?.get(id).copied()
    }

    /// Returns the OS process id for a running instance, if it has one. Used by
    /// the metrics sampler to resolve the process tree without touching the
    /// `Child` handle (which would contend with the kill/wait paths).
    pub fn pid_for(&self, id: &str) -> Option<u32> {
        let map = self.processes.lock().ok()?;
        map.get(id).map(|rp| rp.pid)
    }
}

/// Resolves `{{userOverrides.<key>}}` placeholders in a template string.
///
/// Mirrors the contract documented in ArchitecturePlan §5.
pub fn resolve_variables(template: &str, variables: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (key, val) in variables {
        let pattern = format!("{{{{userOverrides.{}}}}}", key);
        out = out.replace(&pattern, val);
    }
    out
}

/// Returns true if `line` already starts with a `[HH:MM:SS]`-style timestamp.
///
/// Deliberately liberal: accepts `[HH:MM]`, `[H:MM:SS.fff]`, `[2:32:07 PM]`,
/// optional brackets, optional AM/PM, and leading whitespace. The goal is to
/// *never* double-stamp — a false positive just means we skip a redundant
/// prefix the line didn't need anyway. Sub-second fractions and localized
/// formats we don't emit are tolerated; the only cost of a false positive is
/// one unstamped line.
///
// The `i += 1` advancing the optional second hour digit trips a false
// positive here; the dump below it reads `i` via `bytes[i]`, but the lint
// sees the path through the hours branch as overwriting. Suppress locally.
#[allow(unused_assignments)]
fn has_timestamp(line: &str) -> bool {
    use std::ops::ControlFlow;

    // Advance I through N ASCII digits starting at I; return Break early if a
    // non-digit is hit before N are consumed.
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

    // Skip optional leading whitespace.
    let mut i = 0;
    while i < len && bytes[i].is_ascii_whitespace() {
        i += 1;
    }

    // Optional opening bracket.
    if i < len && bytes[i] == b'[' {
        i += 1;
    }

    // 1–2 digit hour.
    if digits(bytes, &mut i, 1).is_break() {
        return false;
    }
    if i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= len || bytes[i] != b':' || digits(&bytes, &mut i, 2).is_break() {
        return false;
    }

    // Optional ':SS' (seconds).
    if i < len && bytes[i] == b':' {
        if digits(&bytes, &mut i, 2).is_break() {
            return false;
        }
    }

    // Optional sub-second fraction ('.' then 1+ digits).
    if i < len && bytes[i] == b'.' {
        i += 1;
        if digits(&bytes, &mut i, 1).is_break() {
            return false;
        }
        while i < len && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }

    // Optional AM/PM suffix — tolerate both "AM"/"PM" and a lone trailing "M".
    if matches!(bytes.get(i), Some(b) if *b == b'a' || *b == b'A' || *b == b'p' || *b == b'P')
        && matches!(bytes.get(i + 1), Some(b) if *b == b'm' || *b == b'M')
    {
        i += 2;
    } else if matches!(bytes.get(i), Some(b) if *b == b'm' || *b == b'M') {
        i += 1;
    }

    // If an opening bracket was consumed, a closing ']' may follow.
    if i < len && bytes[i] == b']' {
        i += 1;
    }

    true
}

/// Formats the current wall-clock time as `[HH:MM:SS]` for log prefixes.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day = secs / 86_400;
    let mut tod = secs % 86_400; // seconds since local midnight (UTC)
    // Local timezone offset isn't worth a dependency; normalize to a 24h cycle.
    let _ = day;
    let h = (tod / 3600) % 24;
    tod %= 3600;
    let m = (tod / 60) % 60;
    let s = tod % 60;
    format!("[{h:02}:{m:02}:{s:02}]")
}

/// Writes a line to the instance's latest.log, prefixed with a timestamp.
fn append_log(log_path: &Path, bytes: &[u8]) {
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) else {
        return;
    };
    let _ = file.write_all(timestamp().as_bytes());
    let _ = file.write_all(b" ");
    let _ = file.write_all(bytes);
    if bytes.last() != Some(&b'\n') {
        let _ = file.write_all(b"\n");
    }
}

/// Parses a `.env` file into `(key, value)` pairs. Blank lines and lines
/// beginning with `#` are ignored; an optional leading `export ` prefix and
/// surrounding `"..."` / `'...'` quotes on the value are stripped. Malformed
/// lines (no `=`) are skipped silently — `.env` is a convenience, not a hard
/// requirement, so a bad line shouldn't fail the launch.
fn parse_env_file(path: &Path) -> Vec<(String, String)> {
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
        // Strip a single matched pair of surrounding quotes (not both kinds).
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

/// Splits a templated arg string on whitespace into individual arguments.
///
/// A single manifest arg entry like `{{userOverrides.jvm_args}}` expands to many
/// `-XX` flags; without splitting it would be passed as one giant quoted string.
/// JVM flags contain no spaces or shell metacharacters, so a plain whitespace
/// split is sufficient.
pub fn shell_split(input: &str) -> Vec<String> {
    input.split_whitespace().map(String::from).collect()
}

/// Spawns a server instance's "start" lifecycle step with piped stdio.
///
/// `working_dir` is where the process runs and where `latest.log` is written.
/// If `<working_dir>/.env` exists it is parsed and applied to the child's
/// environment (overriding any inherited host value). On success the process is
/// registered, its stdout+stderr are streamed line-by-line over
/// `log:<id>:stream`, and a `Running` status is emitted. When it exits, an
/// `Exited` status is emitted.
pub fn launch(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    command: &str,
    args: &[String],
) -> Result<(), String> {
    // 0. Start fresh: truncate latest.log so the seeded tail reflects only this
    //    run, not the previous run's `[process terminated …]` marker.
    let log_path = working_dir.join("latest.log");
    if File::create(&log_path).is_err() {
        // Non-fatal — streaming still works, the disk mirror just won't reset.
    }

    // 1. Build the command. std::process::Command inherits the host environment
    //    by default (so PATH etc. are preserved); layer the instance's .env on
    //    top. Pipes on all three streams so we can read output and feed stdin.
    let mut cmd = Command::new(command);
    cmd.current_dir(working_dir);
    cmd.args(args);
    let env_path = working_dir.join(".env");
    for (k, v) in parse_env_file(&env_path) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 2. Spawn. Errors propagate to run_step → the red error banner in the UI,
    //    so a missing binary / bad command never fails silently.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{command}': {e}"))?;

    // Capture the OS pid up front (before the child handle is moved into the
    // registry) so the metrics sampler can resolve the process tree without
    // contending for the child mutex.
    let pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned child has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "spawned child has no stderr pipe".to_string())?;
    let stdin = child.stdin.take();

    // 3. Register the child so stop_server_instance can terminate it. Bump the
    //    per-instance generation so any reader thread still running from a prior
    //    (re)launch of this id can recognise it has been superseded.
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let gen = registry.next_generation(instance_id);
    {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        map.insert(
            instance_id.to_string(),
            RunningProcess {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                pid,
                working_dir: working_dir.to_path_buf(),
            },
        );
    }

    // 4. Notify the UI the process is now running.
    let _ = app_handle.emit(
        &format!("status:{instance_id}"),
        StatusPayload::Running,
    );

    // 5. Two blocking reader threads forward stdout + stderr line-by-line. Std
    //    threads (not tokio) because pipe reads block. The stdout thread owns
    //    teardown: on EOF it waits for the exit code and emits the Exited status
    //    + termination marker (gen-guarded, so a superseded task stays silent).
    let event_name = format!("log:{instance_id}:stream");
    let status_event = format!("status:{instance_id}");

    // --- stderr reader: forward lines, then exit on EOF (no teardown). ---
    let stderr_handle = app_handle.clone();
    let event_name_err = event_name.clone();
    let log_path_err = log_path.clone();
    let id_err = instance_id.to_string();
    std::thread::spawn(move || {
        let registry: tauri::State<'_, ProcessRegistry> = stderr_handle.state();
        let mut reader = BufReader::new(stderr);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => return, // EOF
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[process] stderr read error: {e}");
                    return;
                }
            }
            forward_line(&stderr_handle, &registry, &event_name_err, &log_path_err, &id_err, gen, &buf);
        }
    });

    // --- stdout reader: forward lines, then on EOF do process teardown. ---
    let stdout_handle = app_handle.clone();
    let id = instance_id.to_string();
    std::thread::spawn(move || {
        let registry: tauri::State<'_, ProcessRegistry> = stdout_handle.state();
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break, // EOF — child closed stdout; do teardown below
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[process] stdout read error: {e}");
                    break;
                }
            }
            forward_line(&stdout_handle, &registry, &event_name, &log_path, &id, gen, &buf);
        }

        // stdout is closed — wait for the child to finish and report its exit.
        // If this task was superseded mid-flight, stay silent so the newer task
        // owns the termination marker (otherwise it would render twice).
        let still_mine = registry.current_generation(&id).as_ref() == Some(&gen);
        if still_mine {
            // Remove our registry entry (and take the child to wait on it).
            let child_opt = registry
                .processes
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&id))
                .map(|rp| rp.child.into_inner().expect("child lock poisoned"));
            let exit_code = match child_opt {
                Some(mut child) => match child.wait() {
                    Ok(status) => status.code(),
                    Err(_) => None,
                },
                None => None, // already removed (e.g. stop() took it) — no code
            };
            let _ = stdout_handle.emit(
                &status_event,
                StatusPayload::Exited { code: exit_code },
            );
            let label = match exit_code {
                Some(c) => format!("exit {c}"),
                None => "no exit code".to_string(),
            };
            let marker = format!("[process terminated ({})]", label);
            // Persist the marker to disk too — otherwise re-entering the view
            // (which re-seeds from latest.log) would lose it, making the
            // termination look like it "disappeared". append_log adds the
            // timestamp prefix itself, so pass the bare marker.
            append_log(&log_path, marker.as_bytes());
            let _ = stdout_handle.emit(&event_name, format!("{} {}", timestamp(), marker));
        }
    });

    Ok(())
}

/// Forwards one read chunk to the UI + disk. Shared by the stdout and stderr
/// reader threads. Gen-guarded: a superseded task stops forwarding immediately.
fn forward_line(
    handle: &AppHandle,
    registry: &tauri::State<'_, ProcessRegistry>,
    event_name: &str,
    log_path: &Path,
    id: &str,
    gen: u64,
    bytes: &[u8],
) {
    // Superseded by a newer launch? Stop forwarding immediately.
    if registry.current_generation(id).as_ref() != Some(&gen) {
        return;
    }
    // Read raw bytes and lossy-convert: pipe output isn't guaranteed valid
    // UTF-8 (ANSI color codes, partial multibyte sequences at boundaries).
    let lossy = String::from_utf8_lossy(bytes);
    let trimmed = lossy.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        return;
    }
    append_log(log_path, trimmed.as_bytes());
    // Only stamp if the line didn't already arrive with its own timestamp;
    // emulated consoles sometimes print one of their own and we don't want to
    // double up.
    let stamped = if has_timestamp(trimmed) {
        trimmed.to_string()
    } else {
        format!("{} {}", timestamp(), trimmed)
    };
    let _ = handle.emit(event_name, stamped);
}

/// Terminates a running instance by id. Returns Ok even if not running, so the
/// UI can treat stop as idempotent.
pub fn stop(app_handle: &AppHandle, instance_id: &str) -> Result<(), String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let removed = {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        map.remove(instance_id)
    };
    if let Some(proc) = removed {
        // Killing the child closes its stdout pipe → the stdout reader sees EOF
        // and exits. We don't wait here (the reader thread owns teardown); a
        // kill without a following wait just orphans the child, which the OS
        // reaps, but to be tidy try to take the child and kill+wait it.
        let mut child = proc.child.into_inner().expect("child lock poisoned");
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// Writes bytes to a running instance's stdin stream.
///
/// Returns an error if the instance is not currently tracked as running, or if
/// the write itself fails (e.g. the child's stdin pipe was closed).
pub fn write_stdin(
    app_handle: &AppHandle,
    instance_id: &str,
    data: &str,
) -> Result<(), String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let mut map = registry
        .processes
        .lock()
        .map_err(|e| format!("process registry lock poisoned: {e}"))?;
    let proc = map
        .get_mut(instance_id)
        .ok_or_else(|| format!("instance '{instance_id}' is not running"))?;
    let mut guard = proc
        .stdin
        .lock()
        .map_err(|e| format!("stdin lock poisoned: {e}"))?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| format!("instance '{instance_id}' has no stdin pipe"))?;
    stdin
        .write_all(data.as_bytes())
        .map_err(|e| format!("failed to write stdin to '{instance_id}': {e}"))?;
    Ok(())
}

/// Whether an instance currently has a tracked running process.
pub fn is_running(app_handle: &AppHandle, instance_id: &str) -> bool {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    registry
        .processes
        .lock()
        .map(|m| m.contains_key(instance_id))
        .unwrap_or(false)
}

/// Returns the OS process id for a running instance, if it has one. Used by the
/// metrics sampler to resolve the process tree without locking the `Child`.
pub fn pid_for(app_handle: &AppHandle, instance_id: &str) -> Option<u32> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    registry.pid_for(instance_id)
}
