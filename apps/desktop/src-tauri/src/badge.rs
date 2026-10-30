//! Dock count badge (macOS/Linux) and rendered taskbar overlay badge (Windows).
use tauri::WebviewWindow;

/// The count on the Dock icon (macOS, and Linux desktops that show one) or drawn over the
/// taskbar button (Windows, which has no count of its own). Zero removes it.
#[tauri::command]
pub(crate) fn set_badge(window: WebviewWindow, count: u32) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only Petrina's main window may set the icon's count.".into());
    }
    let count = (count > 0).then_some(count);
    #[cfg(windows)]
    let result = window.set_overlay_icon(
        count.map(|count| tauri::image::Image::new_owned(overlay(count), OVERLAY, OVERLAY)),
    );
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
            let distance =
                ((x as f64 + 0.5 - centre).powi(2) + (y as f64 + 0.5 - centre).powi(2)).sqrt();
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

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(
                row.chunks(4).any(|pixel| pixel == [255, 255, 255, 255]),
                "no digit drawn for {count}"
            );
        }
    }
}
