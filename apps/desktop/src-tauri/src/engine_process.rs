//! The desktop's own engine child and pipes. No accounts, shell commands or process-tree guesses.
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
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
struct Readers(Vec<JoinHandle<()>>);
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
    readers: Readers,
    tail: Arc<Mutex<String>>,
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
    fn diagnostic(&self) -> String {
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

pub(crate) struct Started {
    pub(crate) owner: ChildOwner,
    pub(crate) hello: String,
}
pub(crate) struct StartupFailure {
    pub(crate) message: String,
    pub(crate) remaining: Option<ChildOwner>,
}
enum FirstLine {
    Line(String),
    Eof,
    Failed(String),
}

fn failed(mut owner: ChildOwner, mut message: String) -> StartupFailure {
    let result = owner.settle(STOP_GRACE);
    let said = owner.diagnostic();
    if !said.is_empty() {
        message = format!("{}: {said}", message.trim_end_matches('.'));
    }
    match result {
        StopResult::Exited | StopResult::Killed => StartupFailure {
            message,
            remaining: None,
        },
        StopResult::Handoff => StartupFailure {
            message: format!("{message} Its engine is finishing an accepted handoff."),
            remaining: Some(owner),
        },
        StopResult::Uncertain(issue) => StartupFailure {
            message: format!("{message} {issue}"),
            remaining: Some(owner),
        },
    }
}

static SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// Serialize process spawns within this process so platforms without atomic `pipe2(O_CLOEXEC)`
/// cannot leak a sibling thread's newly created pipe descriptor into another child.
pub(crate) fn spawn_command(command: &mut Command) -> std::io::Result<Child> {
    let _guard = SPAWN_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    command.spawn()
}

/// Own the command immediately after spawn, including every failed-start path.
pub(crate) fn open_command(
    mut command: Command,
    budget: Duration,
) -> Result<Started, StartupFailure> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = spawn_command(&mut command).map_err(|error| StartupFailure {
        message: format!("Petrina could not start its engine: {error}"),
        remaining: None,
    })?;
    open_child(child, budget)
}

/// Complete the startup of this already-owned native child. Command discovery stays with the host.
pub(crate) fn open_child(child: Child, budget: Duration) -> Result<Started, StartupFailure> {
    let mut owner = ChildOwner {
        child,
        line: None,
        handoff: Arc::new(AtomicBool::new(false)),
        readers: Readers::default(),
        tail: Arc::default(),
        cleanup_issue: None,
    };
    owner.line = owner.child.stdin.take();
    let Some(stdout) = owner.child.stdout.take() else {
        return Err(failed(
            owner,
            "Petrina could not talk to its engine.".into(),
        ));
    };
    let Some(stderr) = owner.child.stderr.take() else {
        return Err(failed(
            owner,
            "Petrina could not talk to its engine.".into(),
        ));
    };
    let tail = Arc::clone(&owner.tail);
    owner
        .readers
        .0
        .push(thread::spawn(move || keep_tail(stderr, &tail)));
    let (sender, receiver) = mpsc::channel();
    let handoff = Arc::clone(&owner.handoff);
    owner.readers.0.push(thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        let observation = match reader.read_line(&mut first) {
            Ok(0) => FirstLine::Eof,
            Ok(_) => FirstLine::Line(first),
            Err(error) => FirstLine::Failed(error.to_string()),
        };
        let _ = sender.send(observation);
        read_handoff_events(reader, handoff);
    }));
    let message = match receiver.recv_timeout(budget) {
        Ok(FirstLine::Line(first)) if !first.trim().is_empty() => {
            return Ok(Started {
                owner,
                hello: first.trim().to_string(),
            })
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            "Petrina's engine did not start within 30 seconds.".into()
        }
        Ok(FirstLine::Failed(error)) => {
            format!("Petrina could not read its engine's starting message: {error}")
        }
        _ => "Petrina's engine stopped while starting.".into(),
    };
    Err(failed(owner, message))
}

pub(crate) fn handoff_event(line: &str) -> Option<bool> {
    match line.trim() {
        r#"{"type":"handoff","active":true}"# => Some(true),
        r#"{"type":"handoff","active":false}"# => Some(false),
        _ => None,
    }
}
pub(crate) fn read_handoff_events(mut reader: impl BufRead, handoff: Arc<AtomicBool>) {
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        if let Some(active) = handoff_event(&line) {
            handoff.store(active, Ordering::Release);
        }
        line.clear();
    }
}
pub(crate) fn stop_for_recovery(started: Started) -> Result<(), Started> {
    stop_for_recovery_with_grace(started, STOP_GRACE)
}
pub(crate) fn stop_for_recovery_with_grace(
    mut started: Started,
    grace: Duration,
) -> Result<(), Started> {
    match started.owner.settle(grace) {
        StopResult::Exited | StopResult::Killed => Ok(()),
        StopResult::Handoff | StopResult::Uncertain(_) => Err(started),
    }
}
#[cfg(test)]
pub(crate) fn stop(mut started: Started) -> Result<(), Started> {
    match stop_owner(started.owner) {
        Ok(()) => Ok(()),
        Err(owner) => {
            started.owner = owner;
            Err(started)
        }
    }
}
pub(crate) fn stop_owner(mut owner: ChildOwner) -> Result<(), ChildOwner> {
    match owner.settle(STOP_GRACE) {
        StopResult::Handoff => {
            // Accepted handoffs intentionally outlive this desktop. This waiter only reaps that owner.
            thread::spawn(move || {
                let _ = owner.child.wait();
            });
            Ok(())
        }
        StopResult::Uncertain(_) => Err(owner),
        StopResult::Exited | StopResult::Killed => Ok(()),
    }
}
fn keep_tail(mut stream: impl Read, tail: &Mutex<String>) {
    let mut buffer = [0u8; 4096];
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        if let Ok(mut text) = tail.lock() {
            text.push_str(&String::from_utf8_lossy(&buffer[..read]));
            if text.len() > 600 {
                let cut = text.len() - 600;
                let cut = (cut..text.len())
                    .find(|&at| text.is_char_boundary(at))
                    .unwrap_or(text.len());
                text.drain(..cut);
            }
        }
    }
}

/// The host retains uncertain ownership instead of launching a competing engine.
enum OwnedEngine {
    Ready(Started),
    CleanupPending { owner: ChildOwner, reason: String },
}

#[derive(Default)]
pub(crate) struct EngineConnection {
    engine: Mutex<Option<OwnedEngine>>,
}

impl EngineConnection {
    pub(crate) fn connect(
        &self,
        restart: bool,
        command: impl FnOnce() -> Result<Command, String>,
    ) -> Result<String, String> {
        self.connect_with(restart, || {
            command()
                .map_err(|message| StartupFailure {
                    message,
                    remaining: None,
                })
                .and_then(|command| open_command(command, START_TIMEOUT))
        })
    }
    pub(crate) fn connect_with(
        &self,
        restart: bool,
        start: impl FnOnce() -> Result<Started, StartupFailure>,
    ) -> Result<String, String> {
        let mut slot = self
            .engine
            .lock()
            .map_err(|_| "Petrina's shell is in a bad state. Restart the app.".to_string())?;
        if let Some(previous) = slot.take() {
            match previous {
                OwnedEngine::Ready(mut started) => {
                    let running = match started.owner.observe() {
                        ChildObservation::Running => true,
                        ChildObservation::Exited => false,
                        ChildObservation::Unavailable(error) => {
                            *slot = Some(OwnedEngine::Ready(started));
                            return Err(format!(
                                "Petrina could not check its previous engine: {error}"
                            ));
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
                            return Ok(hello);
                        }
                        ConnectionAction::Recover | ConnectionAction::Launch => {
                            if let Err(previous) = stop_for_recovery(started) {
                                if let Some(reason) = previous.owner.cleanup_issue.clone() {
                                    *slot = Some(OwnedEngine::CleanupPending {
                                        owner: previous.owner,
                                        reason: reason.clone(),
                                    });
                                    return Err(reason);
                                }
                                let hello = previous.hello.clone();
                                *slot = Some(OwnedEngine::Ready(previous));
                                return Ok(hello);
                            }
                        }
                    }
                }
                OwnedEngine::CleanupPending { mut owner, reason } => {
                    match owner.settle(STOP_GRACE) {
                        StopResult::Exited | StopResult::Killed => {}
                        StopResult::Handoff | StopResult::Uncertain(_) => {
                            let reason = owner.cleanup_issue.clone().unwrap_or(reason);
                            *slot = Some(OwnedEngine::CleanupPending {
                                owner,
                                reason: reason.clone(),
                            });
                            return Err(reason);
                        }
                    }
                }
            }
        }
        let started = match start() {
            Ok(started) => started,
            Err(failure) => {
                if let Some(owner) = failure.remaining {
                    *slot = Some(OwnedEngine::CleanupPending {
                        owner,
                        reason: failure.message.clone(),
                    });
                }
                return Err(failure.message);
            }
        };
        let hello = started.hello.clone();
        if hello.starts_with(r#"{"type":"ready""#) {
            *slot = Some(OwnedEngine::Ready(started));
        } else {
            // A launcher that stepped aside still owns its pipes until its own exit is confirmed.
            let mut owner = started.owner;
            match owner.settle(STOP_GRACE) {
                StopResult::Exited | StopResult::Killed => {}
                StopResult::Handoff | StopResult::Uncertain(_) => {
                    let reason = owner.cleanup_issue.clone().unwrap_or_else(|| {
                        "Petrina's engine is finishing an accepted handoff.".into()
                    });
                    *slot = Some(OwnedEngine::CleanupPending {
                        owner,
                        reason: reason.clone(),
                    });
                    return Err(reason);
                }
            }
        }
        Ok(hello)
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
    fn spawn_failure_does_not_claim_an_owned_child_or_fall_back_to_another_program() {
        let absent = std::env::current_exe().unwrap().with_file_name(format!(
            "missing-petrina-owned-actor-{}",
            std::process::id()
        ));
        assert!(!absent.exists());
        let failure = match open_command(Command::new(absent), START_TIMEOUT) {
            Err(failure) => failure,
            Ok(_) => panic!("missing program cannot start"),
        };
        assert!(failure.remaining.is_none());
        assert!(failure.message.contains("could not start its engine"));
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
