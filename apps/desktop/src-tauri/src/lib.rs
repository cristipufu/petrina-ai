// The Rust side stays a thin host. Today it only opens the window; process supervision,
// worktrees, SQLite and the agent bridge socket land here as the engine moves off the simulator.

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The window opens at 1680x1000 (tauri.conf.json), but never larger than the screen's
            // usable area. The 1100x680 minimum still applies.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let usable = monitor.work_area().size.to_logical::<f64>(scale);
                    let outer = window.outer_size()?.to_logical::<f64>(scale);
                    let inner = window.inner_size()?.to_logical::<f64>(scale);
                    if outer.width > usable.width || outer.height > usable.height {
                        // The title bar and frame count against the usable area too.
                        let width = inner.width.min(usable.width - (outer.width - inner.width));
                        let height = inner.height.min(usable.height - (outer.height - inner.height));
                        window.set_size(tauri::LogicalSize::new(width, height))?;
                        window.center()?;
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Petrina failed to start");
}
