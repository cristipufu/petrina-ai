// The Rust side stays a thin host. Today it only opens the window; process supervision,
// worktrees, SQLite and the agent bridge socket land here as the engine moves off the simulator.

use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

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
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("Petrina failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: (f64, f64) = (1680.0, 1000.0);
    const MIN: (f64, f64) = (1100.0, 680.0);
    /// A macOS title bar: 28 points tall (32 on macOS 26), no side borders.
    const TITLE: (f64, f64) = (0.0, 28.0);

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
    fn works_in_physical_pixels_on_a_retina_screen() {
        // The 14-inch MacBook again, at a scale of 2.
        let usable = screen(0.0, 76.0, 3024.0, 1760.0);
        let at = placement(usable, (0.0, 56.0), (3360.0, 2000.0), (2200.0, 1360.0));
        assert_eq!((at.width, at.height), (3024.0, 1704.0));
        assert!(fits(at, usable, (0.0, 56.0)));
    }
}
