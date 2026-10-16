// The Rust side stays a thin host. It starts the engine (TypeScript), passes the engine's
// address and key to the main window, and stops the engine it started when the app quits.
// Whether an engine is already running is the engine's call, not the shell's: an engine started
// in app mode steps aside for one that is running and says so on its first line.
//
// The engine's stdin is the private line between the two: the engine says it is ready on stdout,
// and stdin closing (a quit, a crash, a force-quit) tells it the app is gone, so it stops itself.

use std::io::{BufRead, BufReader, Read};
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

/// How long a starting engine may take to say it is ready.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an engine gets to stop its agents and save once its line closes.
const STOP_GRACE: Duration = Duration::from_secs(8);
/// Keeps console windows from flashing up on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The engine this app started.
struct Started {
    child: Child,
    /// Closing it is how the engine learns the app is gone.
    line: Option<ChildStdin>,
    /// The engine's first line, passed to the window as is.
    hello: String,
}

#[derive(Default)]
struct Shell {
    engine: Mutex<Option<Started>>,
}

impl Shell {
    /// The engine's details for the window. One at a time: a window asking twice gets the same engine.
    fn connect(&self, app: &tauri::AppHandle, restart: bool) -> Result<String, String> {
        let mut slot = self
            .engine
            .lock()
            .map_err(|_| "Petrina's shell is in a bad state. Restart the app.".to_string())?;
        if let Some(started) = slot.as_mut() {
            if !restart && matches!(started.child.try_wait(), Ok(None)) {
                return Ok(started.hello.clone());
            }
        }
        if let Some(started) = slot.take() {
            stop(started);
        }
        let (mut child, line, hello) = start(app)?;
        if hello.starts_with(r#"{"type":"ready""#) {
            *slot = Some(Started {
                child,
                line,
                hello: hello.clone(),
            });
        } else {
            // It stepped aside (or could not start) and exits by itself.
            thread::spawn(move || {
                drop(line);
                let _ = child.wait();
            });
        }
        Ok(hello)
    }

    fn shutdown(&self) {
        let started = match self.engine.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(started) = started {
            stop(started);
        }
    }
}

fn start(app: &tauri::AppHandle) -> Result<(Child, Option<ChildStdin>, String), String> {
    let mut command = engine_command(app)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Petrina could not start its engine: {error}"))?;
    let line = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or("Petrina could not talk to its engine.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Petrina could not talk to its engine.")?;

    // The engine logs to its own file. Whatever else reaches stderr is kept short, for an error.
    let tail = Arc::new(Mutex::new(String::new()));
    let errors = {
        let tail = Arc::clone(&tail);
        thread::spawn(move || keep_tail(stderr, &tail))
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        let _ = reader.read_line(&mut first);
        let _ = sender.send(first);
        // Keep reading, so the engine never waits on a full pipe.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });

    match receiver.recv_timeout(START_TIMEOUT) {
        Ok(first) if !first.trim().is_empty() => Ok((child, line, first.trim().to_string())),
        Err(RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("Petrina's engine did not start within 30 seconds.".into())
        }
        _ => {
            let _ = child.wait();
            let _ = errors.join();
            let said = tail
                .lock()
                .map(|text| text.trim().to_string())
                .unwrap_or_default();
            Err(if said.is_empty() {
                "Petrina's engine stopped while starting.".into()
            } else {
                format!("Petrina's engine stopped while starting: {said}")
            })
        }
    }
}

/// Close the line, give the engine a few seconds to stop its agents and save, then force it.
fn stop(mut started: Started) {
    drop(started.line.take());
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        match started.child.try_wait() {
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            _ => return,
        }
    }
    let _ = started.child.kill();
    let _ = started.child.wait();
}

fn keep_tail(mut stream: impl Read, tail: &Mutex<String>) {
    let mut buffer = [0u8; 4096];
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        if let Ok(mut text) = tail.lock() {
            text.push_str(&String::from_utf8_lossy(&buffer[..read]));
            if text.len() > 600 {
                let cut = text.len() - 600;
                let cut = (cut..text.len())
                    .find(|&at| text.is_char_boundary(at))
                    .unwrap_or(text.len());
                text.drain(..cut);
            }
        }
    }
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
        return Err("This copy of Petrina does not include its engine yet. For now, run Petrina from its source folder with: bun run tauri dev".into());
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

/// The window's only command. The capability file allows it for the main window alone; it is checked here too.
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
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![engine_details])
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
