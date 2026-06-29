//! HTTP download utility for plugin setup.
//!
//! Provides a `download_url` Tauri command that fetches a file from a URL,
//! writes it to disk, and emits progress events so the frontend can render
//! a progress bar. Designed for downloading server JARs, modloader installers,
//! and similar artifacts during plugin auto-installation.
//!
//! Uses `ureq` (synchronous, lightweight HTTP client) to avoid pulling in
//! a heavyweight async runtime just for downloads.

use std::fs::File;
use std::io::{Read, BufReader, Write};
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Progress payload emitted as `download:<progress_id>:progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Bytes received so far.
    pub bytes: u64,
    /// Total content length (0 if unknown).
    pub total: u64,
}

/// Downloads a URL to a file on disk, emitting progress events.
///
/// # Parameters
/// - `url` — the URL to fetch
/// - `dest` — absolute path where the file should be written
/// - `progress_id` — a caller-chosen id used in the event name so concurrent
///   downloads don't collide. Events go to `download:{progress_id}:progress`.
///
/// Reads the response body in 64 KiB chunks, writes each chunk to `dest`,
/// and emits a `DownloadProgress` payload after each write. The `total` field
/// is set from `Content-Length` when the server provides it, otherwise 0.
///
/// # Errors
/// Returns a string error for network failures, non-2xx status codes, or
/// disk write failures. The destination file is created/truncated on open
/// and left in a partial state on failure (callers should clean up).
#[tauri::command]
pub fn download_url(
    app_handle: AppHandle,
    url: String,
    dest: String,
    progress_id: String,
) -> Result<(), String> {
    let dest_path = Path::new(&dest);

    // Open the destination file (create/truncate).
    let mut file =
        File::create(dest_path).map_err(|e| format!("failed to create '{}': {e}", dest_path.display()))?;

    // Build the HTTP request.
    let resp = ureq::get(&url)
        .call()
        .map_err(|e| format!("HTTP request failed for '{url}': {e}"))?;

    // Check for a non-2xx status using http::StatusCode.
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {} for '{}'", status.as_u16(), url));
    }

    // Total content length (0 if unknown).
    let total: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let event_name = format!("download:{progress_id}:progress");

    // Read the body in 64 KiB chunks and forward progress.
    // ureq 3: Body::into_reader() returns an impl Read + 'static.
    let mut reader = BufReader::new(resp.into_body().into_reader());
    let mut buf = vec![0u8; 65_536];
    let mut bytes: u64 = 0;

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                file.write_all(&buf[..n])
                    .map_err(|e| format!("write error to '{}': {e}", dest_path.display()))?;
                bytes += n as u64;
                let _ = app_handle.emit(&event_name, DownloadProgress { bytes, total });
            }
            Err(e) => {
                return Err(format!("read error from '{url}': {e}"));
            }
        }
    }

    // Final progress event so the frontend sees bytes == total.
    let _ = app_handle.emit(&event_name, DownloadProgress { bytes, total });

    Ok(())
}

// ---------------------------------------------------------------------------
//  fetch_mc_versions — server-side version-list fetcher
// ---------------------------------------------------------------------------

/// Fetches available Minecraft version strings for a given server runtime.
///
/// Runs HTTP requests server-side via `ureq` so the webview never hits CORS
/// or mixed-content restrictions. Mirrors the endpoint layout used by the
/// plugin's `versionFetcher.ts` and returns versions sorted newest-first.
///
/// Supported runtimes: vanilla, paper, purpur, fabric, forge, neoforge, quilt.
/// Unknown runtimes fall back to the vanilla (Mojang) manifest.
#[tauri::command]
pub fn fetch_mc_versions(runtime: String) -> Result<Vec<String>, String> {
    match runtime.as_str() {
        "vanilla" => fetch_vanilla_versions(false),
        "paper" => fetch_paper_versions(),
        "purpur" => fetch_purpur_versions(),
        "fabric" => fetch_fabric_game_versions(false),
        "forge" => fetch_forge_versions(),
        "neoforge" => fetch_neoforge_versions(),
        "quilt" => fetch_quilt_game_versions(false),
        _ => fetch_vanilla_versions(false),
    }
}

/// Generic JSON GET helper — parses the response body as `serde_json::Value`.
fn get_json(url: &str) -> Result<serde_json::Value, String> {
    ureq::get(url)
        .call()
        .map_err(|e| format!("HTTP request failed for '{url}': {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("failed to parse JSON from '{url}': {e}"))
}

/// Splits "1.20.4" → [1, 20, 4]; trailing non-numeric chars are ignored.
fn version_parts(v: &str) -> Vec<u64> {
    v.split('.')
        .filter_map(|p| p.split(|c: char| !c.is_ascii_digit()).next())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Sorts version strings newest-first by comparing numeric parts.
fn sort_newest_first(versions: &mut Vec<String>) {
    versions.sort_by(|a, b| {
        let ap = version_parts(a);
        let bp = version_parts(b);
        for i in 0..ap.len().max(bp.len()) {
            let an = ap.get(i).copied().unwrap_or(0);
            let bn = bp.get(i).copied().unwrap_or(0);
            if an != bn {
                return bn.cmp(&an);
            }
        }
        std::cmp::Ordering::Equal
    });
}

fn fetch_vanilla_versions(include_snapshots: bool) -> Result<Vec<String>, String> {
    let data = get_json("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json")?;
    let versions = data["versions"]
        .as_array()
        .ok_or_else(|| "invalid vanilla manifest: missing 'versions'".to_string())?;

    let mut out: Vec<String> = versions
        .iter()
        .filter(|v| {
            let t = v["type"].as_str().unwrap_or("");
            if include_snapshots {
                matches!(t, "release" | "snapshot" | "old_beta" | "old_alpha")
            } else {
                t == "release"
            }
        })
        .filter_map(|v| v["id"].as_str().map(|s| s.to_string()))
        .collect();
    sort_newest_first(&mut out);
    Ok(out)
}

fn fetch_paper_versions() -> Result<Vec<String>, String> {
    let data = get_json("https://api.papermc.io/v2/projects/paper")?;
    let versions = data["versions"]
        .as_array()
        .ok_or_else(|| "invalid paper manifest: missing 'versions'".to_string())?;

    let mut out: Vec<String> = versions
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| {
            // Paper occasionally lists milestones like "pre-1"; only keep x.y[.z].
            s.split('.').filter(|p| p.parse::<u64>().is_ok()).count() >= 2
        })
        .collect();
    sort_newest_first(&mut out);
    Ok(out)
}

fn fetch_purpur_versions() -> Result<Vec<String>, String> {
    // Purpur v2 API returns { versions: ["1.20.1", ...] } directly.
    let data = get_json("https://api.purpurmc.org/v2/purpur")?;
    let versions = data["versions"]
        .as_array()
        .ok_or_else(|| "invalid purpur manifest: missing 'versions'".to_string())?;

    let mut out: Vec<String> = versions
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| {
            // Only keep x.y[.z] numeric versions.
            s.split('.').filter(|p| p.parse::<u64>().is_ok()).count() >= 2
        })
        .collect();
    sort_newest_first(&mut out);
    Ok(out)
}

fn fetch_fabric_game_versions(include_unstable: bool) -> Result<Vec<String>, String> {
    let data = get_json("https://meta.fabricmc.net/v2/versions")?;
    let game = data["game"]
        .as_array()
        .ok_or_else(|| "invalid fabric manifest: missing 'game'".to_string())?;

    let mut out: Vec<String> = game
        .iter()
        .filter(|v| {
            include_unstable || v["stable"].as_bool().unwrap_or(false)
        })
        .filter_map(|v| v["version"].as_str().map(|s| s.to_string()))
        .collect();
    sort_newest_first(&mut out);
    Ok(out)
}

fn fetch_forge_versions() -> Result<Vec<String>, String> {
    let data =
        get_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json")?;
    let promos = data["promos"]
        .as_object()
        .ok_or_else(|| "invalid forge manifest: missing 'promos'".to_string())?;

    // Promos keys look like "1.20.2-recommended"; the prefix is the MC version.
    let mut out: Vec<String> = promos
        .keys()
        .filter_map(|k| {
            let dash = k.rfind('-')?;
            let mc = &k[..dash];
            let suffix = &k[dash + 1..];
            if matches!(suffix, "recommended" | "latest") {
                Some(mc.to_string())
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| a.cmp(b));
    out.dedup();
    sort_newest_first(&mut out);
    Ok(out)
}

fn fetch_neoforge_versions() -> Result<Vec<String>, String> {
    // NeoForge's old meta API (api.neoforged.net) no longer resolves. Use the
    // Maven versions endpoint, which lists build names like "20.2.3-beta" or
    // "26.1.2.71". The first two numeric segments encode the MC version
    // (20.2 → 1.20.2, 26.1 → 26.1).
    let data = get_json(
        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    )?;
    let versions = data["versions"]
        .as_array()
        .ok_or_else(|| "invalid neoforge manifest: missing 'versions'".to_string())?;

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for v in versions {
        let Some(build) = v.as_str() else { continue };
        // Extract "<major>.<minor>" from the front of the build name.
        let mut it = build.split('.').take(2);
        let (Some(major_s), Some(minor_s)) = (it.next(), it.next()) else {
            continue;
        };
        let (Ok(major), Ok(minor)) = (major_s.parse::<u64>(), minor_s.parse::<u64>()) else {
            continue;
        };
        // Pre-2025 naming: 20.x → 1.20.x. 2026+ keeps the MC version as-is.
        let mc = if major >= 21 {
            format!("{major}.{minor}")
        } else {
            format!("1.{major}.{minor}")
        };
        if seen.insert(mc.clone()) {
            out.push(mc);
        }
    }
    sort_newest_first(&mut out);
    Ok(out)
}

fn fetch_quilt_game_versions(include_unstable: bool) -> Result<Vec<String>, String> {
    let data = get_json("https://meta.quiltmc.org/v3/versions")?;
    let game = data["game"]
        .as_array()
        .ok_or_else(|| "invalid quilt manifest: missing 'game'".to_string())?;

    let mut out: Vec<String> = game
        .iter()
        .filter(|v| {
            include_unstable || v["stable"].as_bool().unwrap_or(false)
        })
        .filter_map(|v| v["version"].as_str().map(|s| s.to_string()))
        .collect();
    sort_newest_first(&mut out);
    Ok(out)
}
