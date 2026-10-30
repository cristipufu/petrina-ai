//! System notifications, focus checks, and click-to-inbox routing.
use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

use crate::Shell;

/// What a click on a notification opens. The window sends it along and gets it back on a click.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Target {
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
pub(crate) struct Shown {
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
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
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
    window.is_focused().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && window.is_visible().unwrap_or(true)
}

/// Show Petrina's window, restored if it was minimized, and give it focus.
pub(crate) fn bring_to_front(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A click on one of Petrina's notifications: bring the window forward and tell it what to open.
pub(crate) fn clicked(app: &AppHandle, id: Option<i32>) {
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
pub(crate) fn notify(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    body: String,
    target: Target,
    test: bool,
) -> Result<bool, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_finds_its_notification_and_never_guesses() {
        let mut shown = Shown::default();
        let item = shown.remember(Target::Item {
            id: "inbox-7".into(),
        });
        let summary = shown.remember(Target::Inbox);
        let test = shown.remember(Target::App);
        assert_eq!(
            shown.target(Some(item)),
            Target::Item {
                id: "inbox-7".into()
            }
        );
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
            shown.remember(Target::Item {
                id: format!("item-{index}"),
            });
        }
        assert_eq!(shown.targets.len(), REMEMBERED);
        assert_eq!(shown.target(Some(first)), Target::Inbox);
        assert_eq!(
            shown.target(Some(shown.last)),
            Target::Item {
                id: format!("item-{}", REMEMBERED - 1)
            }
        );
    }

    #[test]
    fn the_window_sends_targets_in_plain_json() {
        let item: Target = serde_json::from_str(r#"{"kind":"item","id":"inbox-3"}"#).unwrap();
        assert_eq!(
            item,
            Target::Item {
                id: "inbox-3".into()
            }
        );
        assert_eq!(
            serde_json::to_string(&Target::Inbox).unwrap(),
            r#"{"kind":"inbox"}"#
        );
        assert!(serde_json::from_str::<Target>(r#"{"kind":"elsewhere"}"#).is_err());
        assert!(valid_item("inbox-3"));
        assert!(!valid_item(""));
        assert!(!valid_item("inbox 3"));
        assert!(!valid_item("https://example.com"));
    }

    #[test]
    fn notification_text_is_plain_and_short() {
        assert_eq!(
            plain("  Builder needs your permission\u{7}  ", 120),
            "Builder needs your permission"
        );
        assert_eq!(plain("one\ntwo", 120), "one\ntwo");
        let long = plain(&"word ".repeat(100), 20);
        assert_eq!(long.chars().count(), 20);
        assert!(long.ends_with('…'));
    }
}
