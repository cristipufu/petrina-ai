//! The desktop's own engine child spawn, handshake, and handoff pipe readers.
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(test)]
pub(crate) use crate::engine_connection::EngineConnection;
#[cfg(test)]
pub(crate) use crate::engine_stop::{ChildObservation, START_TIMEOUT};
pub(crate) use crate::engine_stop::{ChildOwner, StopResult, STOP_GRACE};

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
    let mut owner = ChildOwner::new(child);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_process::{
        self, child_entry, controlled_child, start_child, Control, Listener, OwnedOuter,
    };
    use std::time::Instant;

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
    fn parses_only_lifecycle_handoff_lines() {
        let state = Arc::new(AtomicBool::new(false));
        read_handoff_events(
            std::io::Cursor::new(
                b"not json\n{\"type\":\"handoff\",\"active\":true}\n{\"type\":\"handoff\",\"active\":false}\n",
            ),
            Arc::clone(&state),
        );
        assert!(!state.load(Ordering::Acquire));
        read_handoff_events(
            std::io::Cursor::new(b"{\"type\":\"handoff\",\"active\":true}\n"),
            Arc::clone(&state),
        );
        assert!(state.load(Ordering::Acquire));
        read_handoff_events(std::io::Cursor::new(b"ignored\n"), Arc::clone(&state));
        assert!(state.load(Ordering::Acquire));
        read_handoff_events(
            std::io::Cursor::new(b"{\"type\":\"handoff\",\"active\":false}\n"),
            Arc::clone(&state),
        );
        assert!(!state.load(Ordering::Acquire));
        struct Unavailable;
        impl std::io::Read for Unavailable {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private read failure"))
            }
        }
        impl std::io::BufRead for Unavailable {
            fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
                Err(std::io::Error::other("private read failure"))
            }
            fn consume(&mut self, _: usize) {}
        }
        state.store(true, Ordering::Release);
        read_handoff_events(Unavailable, Arc::clone(&state));
        assert!(
            state.load(Ordering::Acquire),
            "an unavailable reader must not invent a cleared handoff"
        );
        assert_eq!(
            handoff_event(r#"{"type":"handoff","active":true}"#),
            Some(true)
        );
        assert_eq!(
            handoff_event(r#"{"type":"handoff","active":false}"#),
            Some(false)
        );
        assert_eq!(
            handoff_event(r#"{"type":"handoff","active":true,"requestId":"private"}"#),
            None
        );
    }

    #[test]
    fn recovery_rechecks_a_handoff_arriving_during_shutdown_before_killing() {
        let (started, mut control) = controlled_child("handoff");
        let old = stop_for_recovery_with_grace(started, Duration::from_secs(1))
            .expect_err("accepted handoff must preserve child");
        assert!(old.owner.handoff.load(Ordering::Acquire));
        let mut child = OwnedOuter(old.owner.child);
        assert!(child.0.try_wait().unwrap().is_none());
        control.ping();
        control.quit();
        assert!(
            child.0.wait().unwrap().success(),
            "fixture owner reaps its handed-off child"
        );
    }

    #[test]
    fn ordinary_recovery_kills_a_live_child_after_its_grace() {
        let (started, mut control) = controlled_child("hold");
        let began = Instant::now();
        assert!(stop_for_recovery_with_grace(started, Duration::from_millis(100)).is_ok());
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "native force cleanup cannot wait for the fixture safety exit"
        );
        control.stopped();
    }

    #[test]
    fn ordinary_quit_closes_stdin_and_reaps_a_cooperative_child() {
        if child_entry() {
            return;
        }
        let (started, mut control) = controlled_child("cooperative");
        stop(started).unwrap_or_else(|_| panic!("owned child cleanup must be confirmed"));
        control.stopped();
    }

    fn outer_exit_probe(mode: &str) -> Control {
        let listener = Listener::new();
        let ready = Listener::new();
        let mut command = Command::new(std::env::current_exe().expect("test executable path"));
        command
            .args([
                "--exact",
                "engine_process::tests::desktop_shutdown_waits_for_owned_child_or_preserves_handoff",
                "--nocapture",
            ])
            .env("PETRINA_OUTER_EXIT_CHILD_CASE", mode)
            .env("PETRINA_OUTER_CONTROL_ADDRESS", listener.address())
            .env("PETRINA_OUTER_READY_ADDRESS", ready.address())
            .env_remove("PETRINA_TEST_SHELL_CHILD")
            .env_remove("PETRINA_TEST_SHELL_CONTROL")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut outer =
            OwnedOuter(spawn_command(&mut command).expect("outer shell test process starts"));
        let control = listener
            .accept()
            .expect("outer shell's child connects to its fixture owner");
        let mut receipt = ready
            .accept()
            .expect("outer completed startup before shutdown timing");
        assert_eq!(receipt.pid, outer.0.id());
        receipt.ready();
        let deadline = Instant::now() + Duration::from_secs(12);
        let status = loop {
            if let Some(status) = outer
                .0
                .try_wait()
                .expect("outer test process can be checked")
            {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "outer shell process must exit after stop returns"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(
            status.success(),
            "outer shell test process should exit successfully"
        );
        control
    }

    #[test]
    fn desktop_shutdown_waits_for_owned_child_or_preserves_handoff() {
        if let Ok(mode) = std::env::var("PETRINA_OUTER_EXIT_CHILD_CASE") {
            let address = std::env::var("PETRINA_OUTER_CONTROL_ADDRESS").unwrap();
            let started = start_child(if mode == "handoff" { "handoff" } else { "hold" }, &address);
            test_process::announce_outer_ready(
                &std::env::var("PETRINA_OUTER_READY_ADDRESS").unwrap(),
            );
            stop(started).unwrap_or_else(|_| panic!("owned child cleanup must be confirmed"));
            std::process::exit(0);
        }

        let mut recovered = outer_exit_probe("ordinary");
        recovered.stopped();

        let mut handed_off = outer_exit_probe("handoff");
        handed_off.ping();
        handed_off.quit();
    }

    #[test]
    fn an_accepted_handoff_survives_beyond_the_eight_second_shutdown_grace() {
        assert_eq!(STOP_GRACE, Duration::from_secs(8));
        let (started, mut control) = controlled_child("hold");
        started.owner.handoff.store(true, Ordering::Release);
        stop(started).unwrap_or_else(|_| panic!("owned child cleanup must be confirmed"));
        thread::sleep(Duration::from_millis(8_100));
        control.ping();
        control.quit();
    }
}
