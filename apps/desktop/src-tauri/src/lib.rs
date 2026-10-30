// The Rust side stays a thin host. It starts the engine (TypeScript), passes the engine's
// address and key to the main window, and stops the engine it started when the app quits.
// Whether an engine is already running is the engine's call, not the shell's: an engine started
// in app mode steps aside for one that is running and says so on its first line.
//
// The engine's stdin is the private line between the two: the engine says it is ready on stdout,
// and stdin closing (a quit, a crash, a force-quit) tells it the app is gone, so it stops itself.
//
// It also shows the window's notifications, sets the count on the Dock or taskbar icon, and keeps
// Petrina to one running copy. The window decides what to say and when; the shell only shows it.

#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_notification::NotificationExt;

mod badge;
mod engine_connection;
mod engine_process;
mod engine_release;
mod engine_stop;
mod notifications;
#[cfg(test)]
mod test_process;
mod window_placement;

#[derive(Default)]
pub(crate) struct Shell {
    engine: engine_connection::EngineConnection,
    pub(crate) shown: Mutex<notifications::Shown>,
}

impl Shell {
    fn connect(&self, app: &tauri::AppHandle, restart: bool) -> Result<String, String> {
        let home = engine_release::petrina_home();
        self.engine.connect_managed(
            restart,
            home.as_deref(),
            command_for_release,
            || engine_command(app),
            engine_stop::START_TIMEOUT,
        )
    }

    fn shutdown(&self) {
        self.engine.shutdown();
    }
}

fn command_for_release(
    pointer: &engine_release::ReleasePointer,
    rollback_note: Option<(&str, &str)>,
) -> Result<Command, String> {
    let mut command = match pointer.kind {
        engine_release::ReleaseKind::Binary => {
            let mut cmd = Command::new(&pointer.entrypoint);
            cmd.arg("app");
            cmd
        }
        engine_release::ReleaseKind::Bun => {
            #[cfg(debug_assertions)]
            {
                let bun = find_bun().ok_or(
                    "Petrina needs Bun to run its engine. Install it from https://bun.sh, then try again.",
                )?;
                let mut cmd = Command::new(bun);
                cmd.arg(&pointer.entrypoint).arg("app");
                cmd
            }
            #[cfg(not(debug_assertions))]
            {
                return Err("Installed versions only run a compiled engine binary.".into());
            }
        }
    };
    if let Some((message, version)) = rollback_note {
        command
            .env("PETRINA_AUTO_ROLLBACK_MESSAGE", message)
            .env("PETRINA_AUTO_ROLLBACK_VERSION", version);
    }
    Ok(command)
}

/// Development builds run the engine from the source folder they were built from.
#[cfg(debug_assertions)]
fn engine_command(_app: &tauri::AppHandle) -> Result<Command, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(PathBuf::from)
        .ok_or("Petrina cannot find its source folder.")?;
    let cli = root
        .join("packages")
        .join("engine")
        .join("src")
        .join("cli.ts");
    if !cli.is_file() {
        return Err(format!(
            "Petrina's engine is no longer in {}.",
            root.display()
        ));
    }
    let bun = find_bun().ok_or(
        "Petrina needs Bun to run its engine. Install it from https://bun.sh, then try again.",
    )?;
    let mut command = Command::new(bun);
    command.arg(cli).arg("app").current_dir(root);
    Ok(command)
}

/// Installed versions only run an engine shipped inside the app, never code from a source folder.
#[cfg(not(debug_assertions))]
fn engine_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let name = if cfg!(windows) {
        "petrina-engine.exe"
    } else {
        "petrina-engine"
    };
    let engine = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("engine")
        .join(name);
    if !engine.is_file() {
        return Err(
            "This copy of Petrina does not include its engine yet. For now, run Petrina from its source folder with: bun run tauri dev"
                .into(),
        );
    }
    let mut command = Command::new(engine);
    command.arg("app");
    Ok(command)
}

/// Bun on the search path, or in its usual install folder when an app menu started the app.
#[cfg(debug_assertions)]
fn find_bun() -> Option<PathBuf> {
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let on_path = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    let usual = [
        std::env::var_os("BUN_INSTALL").map(PathBuf::from),
        home.map(|home| home.join(".bun")),
    ]
    .into_iter()
    .flatten()
    .map(|dir| dir.join("bin"));
    let packaged = ["/opt/homebrew/bin", "/usr/local/bin"]
        .into_iter()
        .map(PathBuf::from);
    on_path
        .into_iter()
        .chain(usual)
        .chain(packaged)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

/// The engine's details. Like the window's other commands, the capability file allows it for the
/// main window alone; it is checked here too.
#[tauri::command]
async fn engine_details(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    restart: bool,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Only Petrina's main window may ask for the engine.".into());
    }
    tauri::async_runtime::spawn_blocking(move || app.state::<Shell>().connect(&app, restart))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second copy hands over before it starts anything: opening Petrina again, by
        // hand or by the system for a notification, brings the running one forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            notifications::bring_to_front(app);
            let _ = app.emit_to("main", "relaunched", ());
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            engine_details,
            notifications::notify,
            badge::set_badge
        ])
        .setup(|app| {
            // Clicks on Petrina's notifications, as far as the system reports them: on macOS, on
            // screen and from Notification Center; on Windows, only while the toast is on screen.
            let handle = app.handle().clone();
            app.notification().on_action(move |performed| {
                if performed.action_id() == "tap" {
                    notifications::clicked(
                        &handle,
                        performed.notification().map(|shown| shown.id()),
                    );
                }
            })?;
            // The window starts hidden (tauri.conf.json) and shows once it has its place.
            let sizes = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .map(|config| {
                    (
                        (config.width, config.height),
                        (
                            config.min_width.unwrap_or(0.0),
                            config.min_height.unwrap_or(0.0),
                        ),
                    )
                });
            if let Some(window) = app.get_webview_window("main") {
                if let Some((open, min)) = sizes {
                    if let Err(error) = window_placement::place(&window, open, min) {
                        eprintln!("Petrina could not size its window: {error}");
                    }
                }
                window.show()?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Petrina failed to start")
        .run(|app, event| {
            // The Quit menu, its shortcut, or the last window closing: stop the engine this app started.
            // An engine that was already running is left alone.
            if let RunEvent::Exit = event {
                app.state::<Shell>().shutdown();
            }
        });
}
