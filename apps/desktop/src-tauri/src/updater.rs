// Signed in-app updates via `tauri-plugin-updater`. Only Petrina's own Rust commands talk to the
// updater (the webview gets no direct updater or network plugin permissions), and `restart_app`
// stops Petrina's owned engine cleanly before relaunching the updated binary.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub(crate) struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub(crate) struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn ensure_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only Petrina's main window may manage updates.".into());
    }
    Ok(())
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let failed =
        |error: tauri_plugin_updater::Error| format!("Couldn't check for updates: {error}");
    let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
    if let Ok(endpoint) = std::env::var("PETRINA_UPDATE_ENDPOINT") {
        let trimmed = endpoint.trim();
        if !trimmed.is_empty() {
            let url = trimmed
                .parse()
                .map_err(|_| String::from("PETRINA_UPDATE_ENDPOINT isn't a valid URL."))?;
            builder = builder.endpoints(vec![url]).map_err(failed)?;
        }
    }
    builder.build().map_err(failed)
}

#[tauri::command]
pub(crate) async fn check_update(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    ensure_main_window(&window)?;
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("Couldn't check for updates: {error}"))?;
    let info = update.as_ref().map(|entry| UpdateInfo {
        version: entry.version.clone(),
        current: entry.current_version.clone(),
        notes: entry.body.clone().filter(|body| !body.trim().is_empty()),
    });
    *pending
        .0
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = update;
    Ok(info)
}

#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let update = pending
        .0
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
        .ok_or_else(|| String::from("No update is waiting. Check for updates again."))?;
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let step = total.map_or(256 * 1024, |size| (size / 100).max(1));
                if downloaded - reported >= step || total == Some(downloaded) {
                    reported = downloaded;
                    let _ = app.emit("update-progress", UpdateProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|error| format!("Couldn't install the update: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn restart_app(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_main_window(&window)?;
    app.state::<crate::Shell>().shutdown();
    app.restart();
}
