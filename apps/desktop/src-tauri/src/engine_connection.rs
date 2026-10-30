//! Managed engine connection slot, reuse/recovery arbitration, and automatic release rollback.
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use crate::engine_process::{open_command, stop_for_recovery, stop_owner, Started, StartupFailure};
use crate::engine_release::{self, ReleasePointer};
use crate::engine_stop::{ChildObservation, ChildOwner, StopResult, STOP_GRACE};

/// The host retains uncertain ownership instead of launching a competing engine.
enum OwnedEngine {
    Ready(Started),
    CleanupPending { owner: ChildOwner, reason: String },
}

enum AttemptOutcome {
    Connected(String),
    Failed(String),
    RollbackEligibleError(String),
    RollbackEligibleHello(String),
}

fn prepare_existing_slot(
    slot: &mut Option<OwnedEngine>,
    restart: bool,
) -> Option<Result<String, String>> {
    let previous = slot.take()?;
    match previous {
        OwnedEngine::Ready(mut started) => {
            let running = match started.owner.observe() {
                ChildObservation::Running => true,
                ChildObservation::Exited => false,
                ChildObservation::Unavailable(error) => {
                    *slot = Some(OwnedEngine::Ready(started));
                    return Some(Err(format!(
                        "Petrina could not check its previous engine: {error}"
                    )));
                }
            };
            match connection_action(
                running,
                restart,
                started.owner.handoff.load(Ordering::Acquire),
            ) {
                ConnectionAction::Reuse => {
                    let hello = started.hello.clone();
                    *slot = Some(OwnedEngine::Ready(started));
                    Some(Ok(hello))
                }
                ConnectionAction::Recover | ConnectionAction::Launch => {
                    if let Err(previous) = stop_for_recovery(started) {
                        if let Some(reason) = previous.owner.cleanup_issue.clone() {
                            *slot = Some(OwnedEngine::CleanupPending {
                                owner: previous.owner,
                                reason: reason.clone(),
                            });
                            return Some(Err(reason));
                        }
                        let hello = previous.hello.clone();
                        *slot = Some(OwnedEngine::Ready(previous));
                        return Some(Ok(hello));
                    }
                    None
                }
            }
        }
        OwnedEngine::CleanupPending { mut owner, reason } => match owner.settle(STOP_GRACE) {
            StopResult::Exited | StopResult::Killed => None,
            StopResult::Handoff | StopResult::Uncertain(_) => {
                let reason = owner.cleanup_issue.clone().unwrap_or(reason);
                *slot = Some(OwnedEngine::CleanupPending {
                    owner,
                    reason: reason.clone(),
                });
                Some(Err(reason))
            }
        },
    }
}

fn evaluate_attempt(
    slot: &mut Option<OwnedEngine>,
    result: Result<Started, StartupFailure>,
    allow_rollback: bool,
) -> AttemptOutcome {
    let started = match result {
        Ok(started) => started,
        Err(failure) => {
            if let Some(owner) = failure.remaining {
                *slot = Some(OwnedEngine::CleanupPending {
                    owner,
                    reason: failure.message.clone(),
                });
                return AttemptOutcome::Failed(failure.message);
            }
            if allow_rollback {
                return AttemptOutcome::RollbackEligibleError(failure.message);
            }
            return AttemptOutcome::Failed(failure.message);
        }
    };
    let hello = started.hello.clone();
    if hello.starts_with(r#"{"type":"ready""#) {
        *slot = Some(OwnedEngine::Ready(started));
        return AttemptOutcome::Connected(hello);
    }
    // A launcher that stepped aside still owns its pipes until its own exit is confirmed.
    let mut owner = started.owner;
    match owner.settle(STOP_GRACE) {
        StopResult::Exited | StopResult::Killed => {
            if allow_rollback
                && hello.starts_with(r#"{"type":"error""#)
                && !engine_release::error_line_blocks_rollback(&hello)
            {
                AttemptOutcome::RollbackEligibleHello(hello)
            } else {
                AttemptOutcome::Connected(hello)
            }
        }
        StopResult::Handoff | StopResult::Uncertain(_) => {
            let reason = owner
                .cleanup_issue
                .clone()
                .unwrap_or_else(|| "Petrina's engine is finishing an accepted handoff.".into());
            *slot = Some(OwnedEngine::CleanupPending {
                owner,
                reason: reason.clone(),
            });
            AttemptOutcome::Failed(reason)
        }
    }
}

#[derive(Default)]
pub(crate) struct EngineConnection {
    engine: Mutex<Option<OwnedEngine>>,
}

impl EngineConnection {
    pub(crate) fn connect_managed(
        &self,
        restart: bool,
        home: Option<&Path>,
        release_command: impl Fn(&ReleasePointer, Option<(&str, &str)>) -> Result<Command, String>,
        fallback_command: impl FnOnce() -> Result<Command, String>,
        budget: Duration,
    ) -> Result<String, String> {
        self.connect_managed_with(
            restart,
            home,
            |pointer, rollback_note| {
                release_command(pointer, rollback_note)
                    .map_err(|message| StartupFailure {
                        message,
                        remaining: None,
                    })
                    .and_then(|command| open_command(command, budget))
            },
            || {
                fallback_command()
                    .map_err(|message| StartupFailure {
                        message,
                        remaining: None,
                    })
                    .and_then(|command| open_command(command, budget))
            },
        )
    }

    pub(crate) fn connect_managed_with(
        &self,
        restart: bool,
        home: Option<&Path>,
        mut start_release: impl FnMut(
            &ReleasePointer,
            Option<(&str, &str)>,
        ) -> Result<Started, StartupFailure>,
        start_fallback: impl FnOnce() -> Result<Started, StartupFailure>,
    ) -> Result<String, String> {
        let mut slot = self
            .engine
            .lock()
            .map_err(|_| "Petrina's shell is in a bad state. Restart the app.".to_string())?;
        if let Some(early) = prepare_existing_slot(&mut slot, restart) {
            return early;
        }
        let current = home.and_then(engine_release::read_current);
        let outcome = if let Some(ref cur_ptr) = current {
            evaluate_attempt(&mut slot, start_release(cur_ptr, None), true)
        } else {
            evaluate_attempt(&mut slot, start_fallback(), false)
        };
        let detail = match outcome {
            AttemptOutcome::Connected(hello) => return Ok(hello),
            AttemptOutcome::Failed(error) => return Err(error),
            AttemptOutcome::RollbackEligibleError(ref err) => err.clone(),
            AttemptOutcome::RollbackEligibleHello(ref hello) => hello.clone(),
        };
        if let (Some(dir), Some(cur_ptr)) = (home, current.as_ref()) {
            if let Some(prev_ptr) = engine_release::read_previous(dir) {
                if prev_ptr.version != cur_ptr.version {
                    if let Ok(restored) = engine_release::rollback_to_previous(dir) {
                        let note = format!(
                            "Engine release {} failed to start ({}); automatically rolled back to {}.",
                            cur_ptr.version, detail, restored.version
                        );
                        return match evaluate_attempt(
                            &mut slot,
                            start_release(&restored, Some((&note, &restored.version))),
                            false,
                        ) {
                            AttemptOutcome::Connected(hello)
                            | AttemptOutcome::RollbackEligibleHello(hello) => Ok(hello),
                            AttemptOutcome::Failed(error)
                            | AttemptOutcome::RollbackEligibleError(error) => Err(error),
                        };
                    }
                }
            }
        }
        match outcome {
            AttemptOutcome::RollbackEligibleError(error) | AttemptOutcome::Failed(error) => {
                Err(error)
            }
            AttemptOutcome::RollbackEligibleHello(hello) | AttemptOutcome::Connected(hello) => {
                Ok(hello)
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn connect_with(
        &self,
        restart: bool,
        start: impl FnOnce() -> Result<Started, StartupFailure>,
    ) -> Result<String, String> {
        let mut slot = self
            .engine
            .lock()
            .map_err(|_| "Petrina's shell is in a bad state. Restart the app.".to_string())?;
        if let Some(early) = prepare_existing_slot(&mut slot, restart) {
            return early;
        }
        match evaluate_attempt(&mut slot, start(), false) {
            AttemptOutcome::Connected(hello) | AttemptOutcome::RollbackEligibleHello(hello) => {
                Ok(hello)
            }
            AttemptOutcome::Failed(error) | AttemptOutcome::RollbackEligibleError(error) => {
                Err(error)
            }
        }
    }

    pub(crate) fn shutdown(&self) {
        // Keep the reservation while cleanup runs, so another connection cannot start a competitor.
        let mut slot = match self.engine.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(previous) = slot.take() {
            let owner = match previous {
                OwnedEngine::Ready(started) => started.owner,
                OwnedEngine::CleanupPending { owner, .. } => owner,
            };
            if let Err(owner) = stop_owner(owner) {
                let reason = owner
                    .cleanup_issue
                    .clone()
                    .unwrap_or_else(|| "Petrina could not confirm its engine stopped.".into());
                eprintln!("{reason}");
                *slot = Some(OwnedEngine::CleanupPending { owner, reason });
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionAction {
    Reuse,
    Recover,
    Launch,
}

pub(crate) fn connection_action(
    child_running: bool,
    restart: bool,
    handoff: bool,
) -> ConnectionAction {
    if !child_running {
        ConnectionAction::Launch
    } else if !restart || handoff {
        ConnectionAction::Reuse
    } else {
        ConnectionAction::Recover
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_replaces_only_a_live_owned_child_without_an_accepted_handoff() {
        assert_eq!(
            connection_action(true, false, false),
            ConnectionAction::Reuse
        );
        assert_eq!(
            connection_action(true, true, false),
            ConnectionAction::Recover
        );
        assert_eq!(connection_action(true, true, true), ConnectionAction::Reuse);
        assert_eq!(
            connection_action(false, true, false),
            ConnectionAction::Launch
        );
        assert_eq!(
            connection_action(false, true, true),
            ConnectionAction::Launch
        );
    }

    fn temp_release_home(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|dur| dur.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "petrina-managed-connect-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(dir.join("releases").join("versions").join("1.0.0")).unwrap();
        std::fs::create_dir_all(dir.join("releases").join("versions").join("2.0.0")).unwrap();
        let v1 = dir
            .join("releases")
            .join("versions")
            .join("1.0.0")
            .join("petrina-engine");
        let v2 = dir
            .join("releases")
            .join("versions")
            .join("2.0.0")
            .join("petrina-engine");
        std::fs::write(&v1, "v1").unwrap();
        std::fs::write(&v2, "v2").unwrap();
        engine_release::write_pointer_atomic(
            &dir,
            "previous",
            &ReleasePointer {
                version: "1.0.0".into(),
                entrypoint: v1,
                kind: engine_release::ReleaseKind::Binary,
                promoted_at: 100,
            },
        )
        .unwrap();
        engine_release::write_pointer_atomic(
            &dir,
            "current",
            &ReleasePointer {
                version: "2.0.0".into(),
                entrypoint: v2,
                kind: engine_release::ReleaseKind::Binary,
                promoted_at: 200,
            },
        )
        .unwrap();
        dir
    }

    #[test]
    fn managed_connect_automatically_rolls_back_to_previous_on_confirmed_startup_failure() {
        let home = temp_release_home("auto-rollback");
        let (mut started, mut control) = crate::test_process::controlled_child("cooperative");
        started.hello =
            r#"{"type":"ready","owned":true,"url":"http://127.0.0.1:4100","token":"t"}"#
                .to_string();
        let mut started_slot = Some(started);
        let mut attempts: Vec<(String, Option<String>)> = Vec::new();
        let connection = EngineConnection::default();

        let hello = connection
            .connect_managed_with(
                false,
                Some(&home),
                |pointer, note| {
                    attempts.push((
                        pointer.version.clone(),
                        note.map(|(msg, ver)| format!("{ver}:{msg}")),
                    ));
                    if pointer.version == "2.0.0" {
                        Err(StartupFailure {
                            message: "broken release crashed on startup".into(),
                            remaining: None,
                        })
                    } else {
                        Ok(started_slot.take().expect("restored child starts once"))
                    }
                },
                || panic!("fallback command must not run when a promoted release exists"),
            )
            .expect("rollback connects previous verified release");

        assert!(hello.contains(r#""type":"ready""#));
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].0, "2.0.0");
        assert!(attempts[0].1.is_none());
        assert_eq!(attempts[1].0, "1.0.0");
        assert!(attempts[1]
            .1
            .as_deref()
            .unwrap_or("")
            .contains("automatically rolled back to 1.0.0"));
        assert_eq!(
            engine_release::read_current(&home).unwrap().version,
            "1.0.0"
        );

        connection.shutdown();
        control.stopped();
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn managed_connect_preserves_current_release_when_engine_reports_intentional_stop() {
        let home = temp_release_home("intentional-stop");
        let (mut started, mut control) = crate::test_process::controlled_child("cooperative");
        started.hello = r#"{"type":"error","message":"The engine was intentionally stopped. Use petrina engine start to start it again."}"#.to_string();
        let mut started_slot = Some(started);
        let mut versions = Vec::new();
        let connection = EngineConnection::default();

        let hello = connection
            .connect_managed_with(
                false,
                Some(&home),
                |pointer, _| {
                    versions.push(pointer.version.clone());
                    Ok(started_slot.take().unwrap())
                },
                || panic!("fallback must not run"),
            )
            .expect("intentional stop error line is returned without rollback");

        assert!(hello.contains("intentionally stopped"));
        assert_eq!(versions, vec!["2.0.0".to_string()]);
        assert_eq!(
            engine_release::read_current(&home).unwrap().version,
            "2.0.0"
        );
        control.stopped();
        let _ = std::fs::remove_dir_all(&home);
    }
}
