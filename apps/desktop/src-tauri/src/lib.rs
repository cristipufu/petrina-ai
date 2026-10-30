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

use std::collections::VecDeque;
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::Command;
#[cfg(test)]
use std::process::Stdio;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::thread;
#[cfg(test)]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

#[cfg(test)]
mod test_process;

mod engine_process;
#[cfg(test)]
use engine_process::{connection_action, handoff_event, read_handoff_events, stop, stop_for_recovery_with_grace, ConnectionAction, Started, STOP_GRACE};

#[derive(Default)]
struct Shell {
    engine: engine_process::EngineConnection,
    shown: Mutex<Shown>,
}
impl Shell {
    fn connect(&self, app: &tauri::AppHandle, restart: bool) -> Result<String, String> {
        self.engine.connect(restart, || engine_command(app))
    }
    fn shutdown(&self) { self.engine.shutdown(); }
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

/// The engine's details. Like the window's other commands, the capability file allows it for the main window alone; it is checked here too.
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

/// What a click on a notification opens. The window sends it along and gets it back on a click.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Target {
    /// One inbox item.
    Item { id: String },
    /// The inbox with nothing selected: a summary, or a click the system did not trace.
    Inbox,
    /// Petrina itself, nothing else: the test notification.
    App,
}

/// How many shown notifications a click can still be traced to: a full day at the fastest
/// pace (one every ten seconds), a megabyte or so at most.
const REMEMBERED: usize = 24 * 60 * 6;

/// The notifications this run has shown, newest last, so a click finds what it was about.
#[derive(Default)]
struct Shown {
    last: i32,
    targets: VecDeque<(i32, Target)>,
}

impl Shown {
    fn remember(&mut self, target: Target) -> i32 {
        self.last = self.last.checked_add(1).unwrap_or(1);
        if self.targets.len() >= REMEMBERED {
            self.targets.pop_front();
        }
        self.targets.push_back((self.last, target));
        self.last
    }

    /// Never a guess: a notification it no longer knows, or none at all, opens the inbox only.
    fn target(&self, id: Option<i32>) -> Target {
        id.and_then(|id| self.targets.iter().find(|(shown, _)| *shown == id))
            .map(|(_, target)| target.clone())
            .unwrap_or(Target::Inbox)
    }
}

/// Inbox ids are the engine's own: short, plain characters.
fn valid_item(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// Text for a notification: no control characters but line breaks, and never longer than `max`.
fn plain(text: &str, max: usize) -> String {
    let clean: String = text
        .chars()
        .map(|c| if c == '\n' || !c.is_control() { c } else { ' ' })
        .collect();
    let clean = clean.trim();
    if clean.chars().count() <= max {
        return clean.to_string();
    }
    let cut: String = clean.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

fn in_front(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false) && !window.is_minimized().unwrap_or(false) && window.is_visible().unwrap_or(true)
}

/// Show Petrina's window, restored if it was minimized, and give it focus.
fn bring_to_front(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A click on one of Petrina's notifications: bring the window forward and tell it what to open.
fn clicked(app: &AppHandle, id: Option<i32>) {
    let target = match app.state::<Shell>().shown.lock() {
        Ok(shown) => shown.target(id),
        Err(_) => Target::Inbox,
    };
    bring_to_front(app);
    if target != Target::App {
        let _ = app.emit_to("main", "notification-clicked", &target);
    }
}

/// Show a system notification. Not while Petrina is in front, where the window shows its own
/// message instead (the answer is false then), except the test, which always goes out.
#[tauri::command]
fn notify(app: AppHandle, window: WebviewWindow, title: String, body: String, target: Target, test: bool) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Only Petrina's main window may show notifications.".into());
    }
    if let Target::Item { id } = &target {
        if !valid_item(id) {
            return Err("That is not an inbox item Petrina knows.".into());
        }
    }
    if !test && in_front(&window) {
        return Ok(false);
    }
    let id = app
        .state::<Shell>()
        .shown
        .lock()
        .map_err(|_| "Petrina's shell is in a bad state. Restart the app.".to_string())?
        .remember(target);
    app.notification()
        .builder()
        .id(id)
        .title(plain(&title, 120))
        .body(plain(&body, 400))
        .show()
        .map_err(|error| format!("Petrina could not show a notification: {error}"))?;
    Ok(true)
}

/// The count on the Dock icon (macOS, and Linux desktops that show one) or drawn over the
/// taskbar button (Windows, which has no count of its own). Zero removes it.
#[tauri::command]
fn set_badge(window: WebviewWindow, count: u32) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only Petrina's main window may set the icon's count.".into());
    }
    let count = (count > 0).then_some(count);
    #[cfg(windows)]
    let result = window.set_overlay_icon(count.map(|count| tauri::image::Image::new_owned(overlay(count), OVERLAY, OVERLAY)));
    #[cfg(not(windows))]
    let result = window.set_badge_count(count.map(i64::from));
    result.map_err(|error| error.to_string())
}

/// The overlay icon's size in pixels. Windows shows it at a small-icon size, scaled down.
#[cfg_attr(not(windows), allow(dead_code))]
const OVERLAY: u32 = 32;

/// What the overlay says: the count, up to 99, then "99+".
#[cfg_attr(not(windows), allow(dead_code))]
fn badge_text(count: u32) -> String {
    if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    }
}

/// Digits and a plus, 3 by 5, one row per line, the high bit on the left.
#[cfg_attr(not(windows), allow(dead_code))]
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

/// The overlay as RGBA pixels: white digits on a round amber badge (Petrina's colour for
/// "needs you", dark enough for white text), transparent around it.
#[cfg_attr(not(windows), allow(dead_code))]
fn overlay(count: u32) -> Vec<u8> {
    const AMBER: [u8; 3] = [0x9a, 0x5b, 0x00];
    let size = OVERLAY as usize;
    let mut pixels = vec![0u8; size * size * 4];
    let centre = size as f64 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let distance = ((x as f64 + 0.5 - centre).powi(2) + (y as f64 + 0.5 - centre).powi(2)).sqrt();
            // A soft edge one pixel wide.
            let cover = (centre - distance + 0.5).clamp(0.0, 1.0);
            let at = (y * size + x) * 4;
            pixels[at..at + 3].copy_from_slice(&AMBER);
            pixels[at + 3] = (cover * 255.0).round() as u8;
        }
    }
    let text: Vec<char> = badge_text(count).chars().collect();
    let scale = match text.len() {
        1 => 4,
        2 => 3,
        _ => 2,
    };
    let width = text.len() * 3 * scale + (text.len() - 1) * scale;
    let left = (size - width) / 2;
    let top = (size - 5 * scale) / 2;
    for (index, c) in text.iter().enumerate() {
        let x0 = left + index * 4 * scale;
        for (row, bits) in glyph(*c).iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let at = ((top + row * scale + dy) * size + x0 + col * scale + dx) * 4;
                        pixels[at..at + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    pixels
}

/// A rectangle on screen: a position and a size, in one unit.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Where the window opens. Its page wants `open` (1680x1000 in tauri.conf.json) but is never larger
/// than the screen's usable area, the part the menu bar and the Dock or taskbar leave free, and
/// never smaller than `min` (1100x680). `frame` is what the title bar and borders add around the
/// page, and it has to fit too. The result is the page size and the frame's top-left corner:
/// centred in the usable area, or at its top-left when even the minimum does not fit, so the title
/// bar stays reachable.
fn placement(usable: Area, frame: (f64, f64), open: (f64, f64), min: (f64, f64)) -> Area {
    let width = open.0.min(usable.width - frame.0).max(min.0).floor();
    let height = open.1.min(usable.height - frame.1).max(min.1).floor();
    Area {
        x: usable.x + ((usable.width - width - frame.0) / 2.0).max(0.0).floor(),
        y: usable.y + ((usable.height - height - frame.1) / 2.0).max(0.0).floor(),
        width,
        height,
    }
}

/// Size and place the (still hidden) main window on the screen it opens on.
fn place(window: &WebviewWindow, open: (f64, f64), min: (f64, f64)) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    // Physical pixels throughout, so screens with different scales line up.
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let usable = Area {
        x: f64::from(work.position.x),
        y: f64::from(work.position.y),
        width: f64::from(work.size.width),
        height: f64::from(work.size.height),
    };
    // Borders and a title bar outside the window's own size, plus a title bar drawn over its top.
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let over = title_bar_over(window, f64::from(inner.height), scale);
    let frame = (
        f64::from(outer.width.saturating_sub(inner.width)),
        f64::from(outer.height.saturating_sub(inner.height)) + over,
    );
    let at = placement(usable, frame, (open.0 * scale, open.1 * scale), (min.0 * scale, min.1 * scale));
    // The window's own size counts the title bar drawn over it; the page keeps its full size below.
    window.set_min_size(Some(PhysicalSize::new((min.0 * scale).ceil() as u32, (min.1 * scale + over).ceil() as u32)))?;
    window.set_size(PhysicalSize::new(at.width as u32, (at.height + over) as u32))?;
    window.set_position(PhysicalPosition::new(at.x as i32, at.y as i32))?;
    Ok(())
}

/// How much of the window's own height (`inner`, physical pixels) the title bar covers. On macOS,
/// Tauri's standard title bar is drawn over the top of the window and the page starts below it, so
/// a window sized 1680x1000 would show a page about 32 points shorter.
#[cfg(target_os = "macos")]
fn title_bar_over(window: &WebviewWindow, inner: f64, scale: f64) -> f64 {
    let Ok(ns_window) = window.ns_window() else {
        return 0.0;
    };
    // SAFETY: Tauri hands out the window's own live NSWindow, and setup runs on the main thread.
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
    // The part of the window left for the page, below the title bar.
    let page = ns_window.contentLayoutRect().size.height * scale;
    (inner - page).max(0.0).round()
}

#[cfg(not(target_os = "macos"))]
fn title_bar_over(_window: &WebviewWindow, _inner: f64, _scale: f64) -> f64 {
    0.0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second copy hands over before it starts anything: opening Petrina again, by
        // hand or by the system for a notification, brings the running one forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            bring_to_front(app);
            let _ = app.emit_to("main", "relaunched", ());
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![engine_details, notify, set_badge])
        .setup(|app| {
            // Clicks on Petrina's notifications, as far as the system reports them: on macOS, on
            // screen and from Notification Center; on Windows, only while the toast is on screen.
            let handle = app.handle().clone();
            app.notification().on_action(move |performed| {
                if performed.action_id() == "tap" {
                    clicked(&handle, performed.notification().map(|shown| shown.id()));
                }
            })?;
            // The window starts hidden (tauri.conf.json) and shows once it has its place.
            let sizes = app.config().app.windows.iter().find(|config| config.label == "main").map(|config| {
                (
                    (config.width, config.height),
                    (config.min_width.unwrap_or(0.0), config.min_height.unwrap_or(0.0)),
                )
            });
            if let Some(window) = app.get_webview_window("main") {
                if let Some((open, min)) = sizes {
                    if let Err(error) = place(&window, open, min) {
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

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: (f64, f64) = (1680.0, 1000.0);
    const MIN: (f64, f64) = (1100.0, 680.0);
    /// A macOS title bar: 28 points tall (32 on macOS 26), no side borders.
    const TITLE: (f64, f64) = (0.0, 28.0);

    #[test]
    fn recovery_replaces_only_a_live_owned_child_without_an_accepted_handoff() {
        assert_eq!(connection_action(true, false, false), ConnectionAction::Reuse);
        assert_eq!(connection_action(true, true, false), ConnectionAction::Recover);
        assert_eq!(connection_action(true, true, true), ConnectionAction::Reuse);
        assert_eq!(connection_action(false, true, false), ConnectionAction::Launch);
        assert_eq!(connection_action(false, true, true), ConnectionAction::Launch);
    }

    #[test]
    fn parses_only_lifecycle_handoff_lines() {
        let state = Arc::new(AtomicBool::new(false));
        read_handoff_events(
            std::io::Cursor::new(b"not json\n{\"type\":\"handoff\",\"active\":true}\n{\"type\":\"handoff\",\"active\":false}\n"),
            Arc::clone(&state),
        );
        assert!(!state.load(Ordering::Acquire));
        read_handoff_events(std::io::Cursor::new(b"{\"type\":\"handoff\",\"active\":true}\n"), Arc::clone(&state));
        assert!(state.load(Ordering::Acquire));
        read_handoff_events(std::io::Cursor::new(b"ignored\n"), Arc::clone(&state));
        assert!(state.load(Ordering::Acquire));
        read_handoff_events(std::io::Cursor::new(b"{\"type\":\"handoff\",\"active\":false}\n"), Arc::clone(&state));
        assert!(!state.load(Ordering::Acquire));
        struct Unavailable;
        impl std::io::Read for Unavailable {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> { Err(std::io::Error::other("private read failure")) }
        }
        impl std::io::BufRead for Unavailable {
            fn fill_buf(&mut self) -> std::io::Result<&[u8]> { Err(std::io::Error::other("private read failure")) }
            fn consume(&mut self, _: usize) {}
        }
        state.store(true, Ordering::Release);
        read_handoff_events(Unavailable, Arc::clone(&state));
        assert!(state.load(Ordering::Acquire), "an unavailable reader must not invent a cleared handoff");
        assert_eq!(handoff_event(r#"{"type":"handoff","active":true}"#), Some(true));
        assert_eq!(handoff_event(r#"{"type":"handoff","active":false}"#), Some(false));
        assert_eq!(handoff_event(r#"{"type":"handoff","active":true,"requestId":"private"}"#), None);
    }

    use super::test_process::{child_entry, controlled_child, start_child, Control, Listener, OwnedOuter};

    #[test]
    fn recovery_rechecks_a_handoff_arriving_during_shutdown_before_killing() {
        let (started, mut control) = controlled_child("handoff");
        let old = stop_for_recovery_with_grace(started, Duration::from_secs(1)).expect_err("accepted handoff must preserve child");
        assert!(old.owner.handoff.load(Ordering::Acquire));
        let mut child = OwnedOuter(old.owner.child);
        assert!(child.0.try_wait().unwrap().is_none());
        control.ping();
        control.quit();
        assert!(child.0.wait().unwrap().success(), "fixture owner reaps its handed-off child");
    }

    #[test]
    fn ordinary_recovery_kills_a_live_child_after_its_grace() {
        let (started, mut control) = controlled_child("hold");
        let began = Instant::now();
        assert!(stop_for_recovery_with_grace(started, Duration::from_millis(100)).is_ok());
        assert!(began.elapsed() < Duration::from_secs(3), "native force cleanup cannot wait for the fixture safety exit");
        control.stopped();
    }

    #[test]
    fn ordinary_quit_closes_stdin_and_reaps_a_cooperative_child() {
        if child_entry() { return; }
        let (started, mut control) = controlled_child("cooperative");
        stop(started).unwrap_or_else(|_| panic!("owned child cleanup must be confirmed"));
        control.stopped();
    }

    fn outer_exit_probe(mode: &str) -> Control {
        let listener = Listener::new();
        let ready = Listener::new();
        let mut command = Command::new(std::env::current_exe().expect("test executable path"));
        command
            .args(["--exact", "tests::desktop_shutdown_waits_for_owned_child_or_preserves_handoff", "--nocapture"])
            .env("PETRINA_OUTER_EXIT_CHILD_CASE", mode)
            .env("PETRINA_OUTER_CONTROL_ADDRESS", listener.address())
            .env("PETRINA_OUTER_READY_ADDRESS", ready.address())
            .env_remove("PETRINA_TEST_SHELL_CHILD").env_remove("PETRINA_TEST_SHELL_CONTROL")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut outer = OwnedOuter(super::engine_process::spawn_command(&mut command).expect("outer shell test process starts"));
        let control = listener.accept().expect("outer shell's child connects to its fixture owner");
        let mut receipt = ready.accept().expect("outer completed startup before shutdown timing");
        assert_eq!(receipt.pid, outer.0.id());
        receipt.ready();
        let deadline = Instant::now() + Duration::from_secs(12);
        let status = loop {
            if let Some(status) = outer.0.try_wait().expect("outer test process can be checked") { break status; }
            assert!(Instant::now() < deadline, "outer shell process must exit after stop returns");
            thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "outer shell test process should exit successfully");
        control
    }

    #[test]
    fn desktop_shutdown_waits_for_owned_child_or_preserves_handoff() {
        if let Ok(mode) = std::env::var("PETRINA_OUTER_EXIT_CHILD_CASE") {
            let address = std::env::var("PETRINA_OUTER_CONTROL_ADDRESS").unwrap();
            let started = start_child(if mode == "handoff" { "handoff" } else { "hold" }, &address);
            test_process::announce_outer_ready(&std::env::var("PETRINA_OUTER_READY_ADDRESS").unwrap());
            stop(started).unwrap_or_else(|_| panic!("owned child cleanup must be confirmed"));
            std::process::exit(0);
        }

        let mut recovered = outer_exit_probe("ordinary");
        recovered.stopped();

        let mut handed_off = outer_exit_probe("handoff");
        handed_off.ping();
        handed_off.quit();
    }

    #[test]
    fn an_accepted_handoff_survives_beyond_the_eight_second_shutdown_grace() {
        assert_eq!(STOP_GRACE, Duration::from_secs(8));
        let (started, mut control) = controlled_child("hold");
        started.owner.handoff.store(true, Ordering::Release);
        stop(started).unwrap_or_else(|_| panic!("owned child cleanup must be confirmed"));
        thread::sleep(Duration::from_millis(8_100));
        control.ping();
        control.quit();
    }

    fn screen(x: f64, y: f64, width: f64, height: f64) -> Area {
        Area { x, y, width, height }
    }

    /// The whole window, title bar included, lies inside the usable area.
    fn fits(at: Area, usable: Area, frame: (f64, f64)) -> bool {
        at.x >= usable.x
            && at.y >= usable.y
            && at.x + at.width + frame.0 <= usable.x + usable.width
            && at.y + at.height + frame.1 <= usable.y + usable.height
    }

    #[test]
    fn opens_at_1680_by_1000_centred_when_the_screen_has_room() {
        // A 1920x1200 screen with a 25pt menu bar and a 70pt Dock.
        let usable = screen(0.0, 25.0, 1920.0, 1105.0);
        let at = placement(usable, TITLE, OPEN, MIN);
        assert_eq!((at.width, at.height), (1680.0, 1000.0));
        assert_eq!((at.x, at.y), (120.0, 25.0 + 38.0));
        assert!(fits(at, usable, TITLE));
    }

    #[test]
    fn shrinks_to_the_usable_area_with_the_title_bar_inside_it() {
        // A 14-inch MacBook at its default scale: 1512x982 with a 38pt menu bar and a 64pt Dock.
        let usable = screen(0.0, 38.0, 1512.0, 880.0);
        let at = placement(usable, TITLE, OPEN, MIN);
        assert_eq!((at.width, at.height), (1512.0, 852.0));
        assert_eq!((at.x, at.y), (0.0, 38.0));
        assert!(fits(at, usable, TITLE));
    }

    #[test]
    fn only_the_tight_side_shrinks() {
        // Wide but short: a 2560x1080 screen with a 40px taskbar and an 8px border on each side.
        let frame = (16.0, 39.0);
        let usable = screen(0.0, 0.0, 2560.0, 1040.0);
        let at = placement(usable, frame, OPEN, MIN);
        assert_eq!((at.width, at.height), (1680.0, 1000.0));
        assert!(fits(at, usable, frame));
        // Tall but narrow.
        let usable = screen(0.0, 25.0, 1440.0, 1575.0);
        let at = placement(usable, TITLE, OPEN, MIN);
        assert_eq!((at.width, at.height), (1440.0, 1000.0));
        assert!(fits(at, usable, TITLE));
    }

    #[test]
    fn follows_the_usable_area_on_a_second_screen() {
        // A second screen to the left of the main one, with the Dock on its left edge.
        let usable = screen(-1680.0 + 80.0, 0.0, 1600.0, 1050.0);
        let at = placement(usable, TITLE, OPEN, MIN);
        assert_eq!((at.width, at.height), (1600.0, 1000.0));
        assert!(fits(at, usable, TITLE));
    }

    #[test]
    fn never_goes_below_the_minimum_and_keeps_the_title_bar_on_screen() {
        // A screen smaller than the minimum window: the title bar stays at the usable top-left.
        let usable = screen(0.0, 25.0, 1024.0, 640.0);
        let at = placement(usable, TITLE, OPEN, MIN);
        assert_eq!((at.width, at.height), (1100.0, 680.0));
        assert_eq!((at.x, at.y), (0.0, 25.0));
    }

    #[test]
    fn a_click_finds_its_notification_and_never_guesses() {
        let mut shown = Shown::default();
        let item = shown.remember(Target::Item { id: "inbox-7".into() });
        let summary = shown.remember(Target::Inbox);
        let test = shown.remember(Target::App);
        assert_eq!(shown.target(Some(item)), Target::Item { id: "inbox-7".into() });
        assert_eq!(shown.target(Some(summary)), Target::Inbox);
        assert_eq!(shown.target(Some(test)), Target::App);
        // The system did not say which one, or it is one this run no longer knows.
        assert_eq!(shown.target(None), Target::Inbox);
        assert_eq!(shown.target(Some(9999)), Target::Inbox);
    }

    #[test]
    fn remembers_the_latest_notifications_only() {
        let mut shown = Shown::default();
        let first = shown.remember(Target::Item { id: "first".into() });
        for index in 0..REMEMBERED {
            shown.remember(Target::Item { id: format!("item-{index}") });
        }
        assert_eq!(shown.targets.len(), REMEMBERED);
        assert_eq!(shown.target(Some(first)), Target::Inbox);
        assert_eq!(shown.target(Some(shown.last)), Target::Item { id: format!("item-{}", REMEMBERED - 1) });
    }

    #[test]
    fn the_window_sends_targets_in_plain_json() {
        let item: Target = serde_json::from_str(r#"{"kind":"item","id":"inbox-3"}"#).unwrap();
        assert_eq!(item, Target::Item { id: "inbox-3".into() });
        assert_eq!(serde_json::to_string(&Target::Inbox).unwrap(), r#"{"kind":"inbox"}"#);
        assert!(serde_json::from_str::<Target>(r#"{"kind":"elsewhere"}"#).is_err());
        assert!(valid_item("inbox-3"));
        assert!(!valid_item(""));
        assert!(!valid_item("inbox 3"));
        assert!(!valid_item("https://example.com"));
    }

    #[test]
    fn notification_text_is_plain_and_short() {
        assert_eq!(plain("  Builder needs your permission\u{7}  ", 120), "Builder needs your permission");
        assert_eq!(plain("one\ntwo", 120), "one\ntwo");
        let long = plain(&"word ".repeat(100), 20);
        assert_eq!(long.chars().count(), 20);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn the_overlay_shows_the_count_up_to_99() {
        assert_eq!(badge_text(1), "1");
        assert_eq!(badge_text(42), "42");
        assert_eq!(badge_text(100), "99+");
        for count in [1, 7, 42, 99, 100, 1234] {
            let pixels = overlay(count);
            assert_eq!(pixels.len(), (OVERLAY * OVERLAY * 4) as usize);
            // Transparent corners, an opaque badge, and some white digit in the middle row.
            assert_eq!(pixels[3], 0);
            let middle = (OVERLAY as usize / 2) * OVERLAY as usize * 4;
            assert!(pixels[middle + 3] > 200);
            let row = &pixels[middle..middle + OVERLAY as usize * 4];
            assert!(row.chunks(4).any(|pixel| pixel == [255, 255, 255, 255]), "no digit drawn for {count}");
        }
    }

    #[test]
    fn works_in_physical_pixels_on_a_retina_screen() {
        // The 14-inch MacBook again, at a scale of 2.
        let usable = screen(0.0, 76.0, 3024.0, 1760.0);
        let at = placement(usable, (0.0, 56.0), (3360.0, 2000.0), (2200.0, 1360.0));
        assert_eq!((at.width, at.height), (3024.0, 1704.0));
        assert!(fits(at, usable, (0.0, 56.0)));
    }
}
