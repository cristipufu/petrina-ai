//! Owned child settlement, handoff observation, and pipe drain confirmation.
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) const START_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(8);
const FORCE_CONFIRM: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ChildObservation {
    Running,
    Exited,
    Unavailable(String),
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum StopResult {
    Exited,
    Handoff,
    Killed,
    Uncertain(String),
}

trait StopProcess {
    fn close_input(&mut self);
    fn observe(&mut self) -> ChildObservation;
    fn handoff(&self) -> bool;
    fn force(&mut self) -> Result<(), String>;
}

trait StopClock {
    fn elapsed(&self) -> Duration;
    fn pause(&mut self, duration: Duration);
}

struct NativeClock(Instant);
impl StopClock for NativeClock {
    fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }
    fn pause(&mut self, duration: Duration) {
        thread::sleep(duration);
    }
}

fn settle_owned(
    process: &mut impl StopProcess,
    clock: &mut impl StopClock,
    grace: Duration,
    confirmation: Duration,
) -> StopResult {
    process.close_input();
    loop {
        let observation = process.observe();
        if observation == ChildObservation::Exited {
            return StopResult::Exited;
        }
        if process.handoff() {
            return StopResult::Handoff;
        }
        if matches!(observation, ChildObservation::Unavailable(_)) {
            break;
        }
        if clock.elapsed() >= grace {
            break;
        }
        clock.pause(POLL.min(grace.saturating_sub(clock.elapsed())));
    }
    // A handoff already arriving through stdout still wins before any force request.
    clock.pause(POLL);
    if process.observe() == ChildObservation::Exited {
        return StopResult::Exited;
    }
    if process.handoff() {
        return StopResult::Handoff;
    }
    let forced = process.force();
    let deadline = clock.elapsed() + confirmation;
    let mut unavailable = None;
    loop {
        match process.observe() {
            ChildObservation::Exited => {
                return if forced.is_ok() {
                    StopResult::Killed
                } else {
                    StopResult::Exited
                }
            }
            ChildObservation::Unavailable(error) => unavailable = Some(error),
            ChildObservation::Running => {}
        }
        if clock.elapsed() >= deadline {
            break;
        }
        clock.pause(POLL.min(deadline.saturating_sub(clock.elapsed())));
    }
    let detail = forced
        .err()
        .or(unavailable)
        .unwrap_or_else(|| "its exit was not confirmed".into());
    StopResult::Uncertain(format!(
        "Petrina could not confirm its previous engine stopped: {detail}"
    ))
}

/// A join is permitted only after the thread has actually finished; a held pipe stays pending.
#[derive(Default)]
pub(crate) struct Readers(pub(crate) Vec<JoinHandle<()>>);
impl Readers {
    fn finish(&mut self, deadline: Instant) -> bool {
        while self.0.iter().any(|reader| !reader.is_finished()) {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        for reader in self.0.drain(..) {
            let _ = reader.join();
        }
        true
    }
}

pub(crate) struct ChildOwner {
    pub(crate) child: Child,
    pub(crate) line: Option<ChildStdin>,
    pub(crate) handoff: Arc<AtomicBool>,
    pub(crate) readers: Readers,
    pub(crate) tail: Arc<Mutex<String>>,
    pub(crate) cleanup_issue: Option<String>,
}

impl StopProcess for ChildOwner {
    fn close_input(&mut self) {
        drop(self.line.take());
    }
    fn observe(&mut self) -> ChildObservation {
        match self.child.try_wait() {
            Ok(Some(_)) => ChildObservation::Exited,
            Ok(None) => ChildObservation::Running,
            Err(error) => ChildObservation::Unavailable(error.to_string()),
        }
    }
    fn handoff(&self) -> bool {
        self.handoff.load(Ordering::Acquire)
    }
    fn force(&mut self) -> Result<(), String> {
        self.child.kill().map_err(|error| error.to_string())
    }
}

impl ChildOwner {
    pub(crate) fn new(child: Child) -> Self {
        Self {
            child,
            line: None,
            handoff: Arc::new(AtomicBool::new(false)),
            readers: Readers::default(),
            tail: Arc::default(),
            cleanup_issue: None,
        }
    }

    pub(crate) fn observe(&mut self) -> ChildObservation {
        StopProcess::observe(self)
    }

    pub(crate) fn settle(&mut self, grace: Duration) -> StopResult {
        self.cleanup_issue = None;
        let began = Instant::now();
        let result = settle_owned(self, &mut NativeClock(began), grace, FORCE_CONFIRM);
        let result = match result {
            StopResult::Exited | StopResult::Killed => {
                let deadline =
                    (began + grace + POLL + FORCE_CONFIRM).min(Instant::now() + FORCE_CONFIRM);
                if self.readers.finish(deadline) {
                    result
                } else {
                    StopResult::Uncertain(
                        "Petrina's previous engine exited, but its output pipes have not closed."
                            .into(),
                    )
                }
            }
            other => other,
        };
        if let StopResult::Uncertain(message) = &result {
            self.cleanup_issue = Some(message.clone());
        }
        result
    }

    pub(crate) fn diagnostic(&self) -> String {
        self.tail
            .lock()
            .map(|tail| tail.trim().to_string())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn controlled(
        child: Child,
        line: Option<ChildStdin>,
        handoff: Arc<AtomicBool>,
    ) -> Self {
        Self {
            child,
            line,
            handoff,
            readers: Readers::default(),
            tail: Arc::default(),
            cleanup_issue: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Effects {
        observations: VecDeque<ChildObservation>,
        last: ChildObservation,
        force_error: Option<String>,
        forces: usize,
        closed: bool,
        handoff: Arc<AtomicBool>,
    }

    impl StopProcess for Effects {
        fn close_input(&mut self) {
            self.closed = true;
        }
        fn observe(&mut self) -> ChildObservation {
            if let Some(next) = self.observations.pop_front() {
                self.last = next;
            }
            match &self.last {
                ChildObservation::Running => ChildObservation::Running,
                ChildObservation::Exited => ChildObservation::Exited,
                ChildObservation::Unavailable(error) => {
                    ChildObservation::Unavailable(error.clone())
                }
            }
        }
        fn handoff(&self) -> bool {
            self.handoff.load(Ordering::Acquire)
        }
        fn force(&mut self) -> Result<(), String> {
            self.forces += 1;
            self.force_error.clone().map_or(Ok(()), Err)
        }
    }

    struct Clock {
        elapsed: Duration,
        on_pause: Option<Arc<AtomicBool>>,
    }

    impl StopClock for Clock {
        fn elapsed(&self) -> Duration {
            self.elapsed
        }
        fn pause(&mut self, duration: Duration) {
            self.elapsed += duration;
            if let Some(handoff) = self.on_pause.take() {
                handoff.store(true, Ordering::Release);
            }
        }
    }

    fn effects(observations: Vec<ChildObservation>, error: Option<&str>) -> (Effects, Clock) {
        (
            Effects {
                observations: observations.into(),
                last: ChildObservation::Running,
                force_error: error.map(str::to_owned),
                forces: 0,
                closed: false,
                handoff: Arc::new(AtomicBool::new(false)),
            },
            Clock {
                elapsed: Duration::ZERO,
                on_pause: None,
            },
        )
    }

    #[test]
    fn force_or_observation_failures_and_missing_completion_never_confirm_cleanup() {
        for error in [None, Some("force failed")] {
            for observation in [
                ChildObservation::Running,
                ChildObservation::Unavailable("observation failed".into()),
            ] {
                let (mut process, mut clock) = effects(vec![observation], error);
                let result = settle_owned(
                    &mut process,
                    &mut clock,
                    Duration::ZERO,
                    Duration::from_millis(100),
                );
                assert!(matches!(result, StopResult::Uncertain(_)));
                assert!(process.closed);
                assert_eq!(process.forces, 1);
                assert_eq!(clock.elapsed, POLL + Duration::from_millis(100));
            }
        }
    }

    #[test]
    fn a_late_confirmed_exit_can_resolve_a_force_error_without_claiming_kill_success() {
        let (mut process, mut clock) = effects(
            vec![
                ChildObservation::Running,
                ChildObservation::Running,
                ChildObservation::Exited,
            ],
            Some("force raced exit"),
        );
        assert_eq!(
            settle_owned(
                &mut process,
                &mut clock,
                Duration::ZERO,
                Duration::from_millis(100)
            ),
            StopResult::Exited
        );
        assert!(process.closed);
        assert_eq!(process.forces, 1);
    }

    #[test]
    fn only_successful_force_plus_observed_exit_reports_killed() {
        let (mut process, mut clock) = effects(
            vec![
                ChildObservation::Running,
                ChildObservation::Running,
                ChildObservation::Exited,
            ],
            None,
        );
        assert_eq!(
            settle_owned(
                &mut process,
                &mut clock,
                Duration::ZERO,
                Duration::from_millis(100)
            ),
            StopResult::Killed
        );
        assert_eq!(process.forces, 1);
    }

    #[test]
    fn completed_and_accepted_or_late_handoff_owners_are_not_forced() {
        let (mut ended, mut clock) = effects(vec![ChildObservation::Exited], None);
        assert_eq!(
            settle_owned(&mut ended, &mut clock, STOP_GRACE, FORCE_CONFIRM),
            StopResult::Exited
        );
        assert_eq!(ended.forces, 0);
        for late in [false, true] {
            let (mut process, mut clock) = effects(vec![], None);
            if late {
                clock.on_pause = Some(Arc::clone(&process.handoff));
            } else {
                process.handoff.store(true, Ordering::Release);
            }
            assert_eq!(
                settle_owned(&mut process, &mut clock, Duration::ZERO, FORCE_CONFIRM),
                StopResult::Handoff
            );
            assert!(process.closed);
            assert_eq!(process.forces, 0);
        }
    }
}
