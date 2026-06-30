//! Plugin manifest loading.
//!
//! Spec: documentation/ArchitecturePlan.md §3 (Plugin Manifest Specification).
//! Each community plugin supplies a `manifest.json` describing its UI entry,
//! configurable fields (configSchema), and lifecycle commands (install/start).
//!
//! In Phase 2 we only consume the `lifecycle` block to resolve the command
//! and args that launch the server process. The configSchema-driven dynamic
//! form engine arrives in Phase 3.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A static tab declaration in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTabInfo {
    pub id: String,
    pub label: String,
}

/// A plugin manifest.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub display_name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    /// Path to the compiled ESM frontend bundle, relative to the manifest.
    #[serde(default)]
    pub ui_entry: Option<String>,
    /// Configuration fields surfaced to the host for dynamic form generation.
    #[serde(default)]
    pub config_schema: Vec<SchemaField>,
    /// Named lifecycle commands (install / start / stop ...).
    #[serde(default)]
    pub lifecycle: LifecycleMap,
    /// Starter files written into a fresh instance directory, keyed by a label
    /// (e.g. "main", "package_json", "cargo_toml"). See ScaffoldFile.
    #[serde(default)]
    pub scaffold: std::collections::HashMap<String, ScaffoldFile>,
    /// Optional static tab declarations.
    /// These describe tabs the plugin may register dynamically at runtime.
    /// The actual mount functions are provided via the JS bundle.
    #[serde(default)]
    pub tabs: Vec<PluginTabInfo>,
}

/// One configurable field in the manifest's configSchema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    pub key: String,
    pub label: String,
    /// "text" | "select" | (future) others.
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub default: String,
    /// Optional dependency: this field's default changes based on another field.
    /// e.g. an "entry" field that defaults to "index.js" under node but
    /// "src/main.rs" under rust.
    #[serde(default)]
    pub depends_on: Option<DependsOn>,
}

/// Declares that a field's default is derived from the value of another field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependsOn {
    /// The key of the field this one depends on (e.g. "runtime").
    pub field: String,
    /// Map of the dependency's value → this field's default.
    pub defaults: HashMap<String, String>,
}

/// A single starter file the host writes into a fresh instance directory.
/// Path may contain templates resolved against the instance's overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldFile {
    /// Relative path inside the instance dir. May use {{userOverrides.*}}.
    pub path: String,
    /// File contents. May use {{userOverrides.*}} templates.
    #[serde(default)]
    pub content: String,
    /// Only write this file when the override `field` equals one of `values`.
    /// Lets a plugin ship runtime-specific scaffolds (e.g. Cargo.toml only for rust).
    #[serde(default)]
    pub when: Option<Condition>,
}

/// A condition gating a scaffold file on an override value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub field: String,
    pub values: Vec<String>,
}

/// A single lifecycle step: a command + args, possibly templated with
/// `{{userOverrides.*}}` placeholders resolved at launch time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LifecycleStep {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Map of lifecycle step name → step. Common keys: "install", "start", "stop".
pub type LifecycleMap = std::collections::HashMap<String, LifecycleStep>;

/// Reads and parses a manifest.json from disk.
pub fn load(manifest_path: &Path) -> Result<Manifest, String> {
    let raw = fs::read_to_string(manifest_path).map_err(|e| {
        format!(
            "failed to read manifest '{}': {e}",
            manifest_path.display()
        )
    })?;
    serde_json::from_str::<Manifest>(&raw).map_err(|e| {
        format!(
            "failed to parse manifest '{}': {e}",
            manifest_path.display()
        )
    })
}

/// Directory containing community plugins: `<app_data>/plugins/`.
pub fn plugins_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("plugins")
}

/// Scans the plugins directory and returns every valid manifest, sorted by id.
/// Broken/malformed plugin folders are skipped (their error is swallowed) so a
/// single bad plugin can't prevent the host from listing the rest.
pub fn discover(plugins_dir: &Path) -> Vec<Manifest> {
    let Ok(entries) = fs::read_dir(plugins_dir) else {
        return Vec::new();
    };
    let mut found: Vec<Manifest> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let manifest_path = entry.path().join("manifest.json");
            if !manifest_path.is_file() {
                return None;
            }
            load(&manifest_path).ok()
        })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

/// Loads a single plugin's manifest by id from the plugins directory.
pub fn load_by_id(plugins_dir: &Path, id: &str) -> Result<Manifest, String> {
    let path = plugins_dir.join(id).join("manifest.json");
    load(&path)
}
