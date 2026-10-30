fn main() {
    // The window's commands are declared here, so the capability file decides which window may call them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["engine_details", "notify", "set_badge"]),
    ))
    .expect("failed to run the Tauri build script");
}
