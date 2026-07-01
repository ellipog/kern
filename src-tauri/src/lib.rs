// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod commands;
mod config;
mod download;
mod java;
mod manifest;
mod metrics;
mod process;
mod scaffold;
mod seed;
mod ui_state;
mod window_state;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(process::ProcessRegistry::default())
        .manage(metrics::MetricsState::default())
        .setup(|app| {
            // Seed sample community plugins from the repo into AppData so the
            // manifest engine can discover them during development.
            if let Ok(base) = config::config_dir(app.handle()) {
                seed::seed(&manifest::plugins_dir(&base));
            }
            // Restore last-saved window geometry before the window is shown.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(state)) = window_state::load(app.handle()) {
                    window_state::restore(&window, &state);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Persist window geometry on close so the next launch reopens here.
            if let WindowEvent::CloseRequested { .. } = event {
                if let Some(window) = window.get_webview_window("main") {
                    if let Ok(state) = window_state::capture(&window) {
                        let _ = window_state::save(window.app_handle(), &state);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::get_servers,
            commands::create_server,
            commands::update_server,
            commands::delete_server,
            commands::delete_server_folder,
            commands::refresh_orphaned_status,
            commands::is_server_running,
            commands::launch_server_instance,
            commands::stop_server_instance,
            commands::update_server_status,
            commands::get_instance_metrics,
            commands::get_host_metrics,
            commands::run_lifecycle_step,
            commands::install_server_instance,
            commands::restart_server_instance,
            commands::get_log_tail,
            commands::open_folder,
            commands::write_stdin_to_instance,
            commands::read_env_file,
            commands::server_file_exists,
            commands::write_server_file,
            commands::read_server_file,
            commands::list_server_directory,
            commands::delete_server_path,
            commands::create_server_directory,
            commands::rename_server_path,
            commands::delete_server_path_recursive,
            commands::open_server_path,
            commands::copy_files_to_server,
            commands::list_plugins,
            commands::get_plugin,
            commands::get_plugin_ui_path,
            commands::install_plugin,
            commands::install_plugin_from_kern,
            commands::validate_kern_file,
            commands::create_plugin_package,
            commands::uninstall_plugin,
            commands::run_instance_command,
            download::download_url,
            download::fetch_mc_versions,
            download::resolve_forge_version,
            commands::backup_world,
            commands::list_backups,
            commands::restore_world,
            commands::delete_backup,
            commands::detect_server_jar,
            java::detect_java,
            java::check_java_version,
            java::download_java,
            ui_state::get_ui_state,
            ui_state::set_ui_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}