// The Rust side stays a thin host. Today it only opens the window; process supervision,
// worktrees, SQLite and the agent bridge socket land here as the engine moves off the simulator.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Petrina failed to start");
}
