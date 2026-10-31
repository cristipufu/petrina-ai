// Best-effort `~/.local/bin/petrina` symlink on macOS and Linux for installed desktop bundles,
// so `petrina` and `petrina mcp` work in terminals and coding agents out of the box without
// overwriting any standalone binary or custom symlink the coordinator installed separately.

#[cfg(all(unix, any(test, not(debug_assertions))))]
use std::fs;
#[cfg(all(unix, any(test, not(debug_assertions))))]
use std::io::{self, ErrorKind};
#[cfg(all(unix, any(test, not(debug_assertions))))]
use std::os::unix::fs::symlink;
#[cfg(all(unix, any(test, not(debug_assertions))))]
use std::path::Path;

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn is_managed_bundle_target(target: &Path) -> bool {
    let text = target.to_string_lossy();
    text.ends_with("/petrina-engine") || text.contains("Petrina.app/")
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
pub(crate) fn ensure_cli_link(bundled_engine: &Path, bin_dir: &Path) -> io::Result<bool> {
    if !bundled_engine.is_file() {
        return Ok(false);
    }
    fs::create_dir_all(bin_dir)?;
    let link_path = bin_dir.join("petrina");
    match fs::symlink_metadata(&link_path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            symlink(bundled_engine, &link_path)?;
            Ok(true)
        }
        Err(error) => Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let current_target = fs::read_link(&link_path)?;
            if current_target == bundled_engine {
                return Ok(false);
            }
            if !is_managed_bundle_target(&current_target) {
                return Ok(false);
            }
            let staging = bin_dir.join(format!(".petrina-link-{}", std::process::id()));
            let _ = fs::remove_file(&staging);
            symlink(bundled_engine, &staging)?;
            if let Err(error) = fs::rename(&staging, &link_path) {
                let _ = fs::remove_file(&staging);
                return Err(error);
            }
            Ok(true)
        }
        Ok(_) => Ok(false),
    }
}

#[cfg(all(unix, not(debug_assertions)))]
pub(crate) fn install_default_cli_link(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        return;
    };
    let Ok(resource_dir) = app.path().resource_dir() else {
        return;
    };
    let bundled_engine = resource_dir.join("engine").join("petrina-engine");
    let bin_dir = home.join(".local").join("bin");
    let _ = ensure_cli_link(&bundled_engine, &bin_dir);
}

#[cfg(not(all(unix, not(debug_assertions))))]
pub(crate) fn install_default_cli_link(_app: &tauri::AppHandle) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "petrina-cli-link-{name}-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_symlink_when_absent_and_updates_moved_bundle_target() {
        let root = temp_dir("create-and-update");
        let old_engine_dir = root.join("Downloads/Petrina.app/Contents/Resources/engine");
        let new_engine_dir = root.join("Applications/Petrina.app/Contents/Resources/engine");
        fs::create_dir_all(&old_engine_dir).unwrap();
        fs::create_dir_all(&new_engine_dir).unwrap();
        let old_engine = old_engine_dir.join("petrina-engine");
        let new_engine = new_engine_dir.join("petrina-engine");
        fs::write(&old_engine, "v1").unwrap();
        fs::write(&new_engine, "v2").unwrap();

        let bin_dir = root.join(".local/bin");
        assert!(ensure_cli_link(&old_engine, &bin_dir).unwrap());
        assert_eq!(fs::read_link(bin_dir.join("petrina")).unwrap(), old_engine);
        assert!(!ensure_cli_link(&old_engine, &bin_dir).unwrap());

        assert!(ensure_cli_link(&new_engine, &bin_dir).unwrap());
        assert_eq!(fs::read_link(bin_dir.join("petrina")).unwrap(), new_engine);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_standalone_binary_and_custom_symlinks() {
        let root = temp_dir("preserve-existing");
        let engine_dir = root.join("Applications/Petrina.app/Contents/Resources/engine");
        fs::create_dir_all(&engine_dir).unwrap();
        let bundled = engine_dir.join("petrina-engine");
        fs::write(&bundled, "bundled").unwrap();

        let standalone_bin = root.join("standalone-bin");
        fs::create_dir_all(&standalone_bin).unwrap();
        let standalone_file = standalone_bin.join("petrina");
        fs::write(&standalone_file, "standalone-cli").unwrap();
        assert!(!ensure_cli_link(&bundled, &standalone_bin).unwrap());
        assert_eq!(
            fs::read_to_string(&standalone_file).unwrap(),
            "standalone-cli"
        );

        let custom_bin = root.join("custom-bin");
        fs::create_dir_all(&custom_bin).unwrap();
        let custom_target = root.join("checkout/packages/engine/src/cli.ts");
        fs::create_dir_all(custom_target.parent().unwrap()).unwrap();
        fs::write(&custom_target, "// source").unwrap();
        symlink(&custom_target, custom_bin.join("petrina")).unwrap();
        assert!(!ensure_cli_link(&bundled, &custom_bin).unwrap());
        assert_eq!(
            fs::read_link(custom_bin.join("petrina")).unwrap(),
            custom_target
        );
        let _ = fs::remove_dir_all(root);
    }
}
