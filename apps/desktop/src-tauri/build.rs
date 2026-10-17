fn main() {
    // The window's one command is declared here, so the capability file decides which window may call it.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["engine_details"])),
    )
    .expect("failed to run the Tauri build script");
}
