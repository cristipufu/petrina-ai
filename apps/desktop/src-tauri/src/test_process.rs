//! Private desktop lifecycle fixtures. Real child handles and loopback controls, with no shell or PID killing.
use super::engine_process::{read_handoff_events, spawn_command, ChildOwner, Started};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const CHILD_TEST: &str =
    "engine_process::tests::ordinary_quit_closes_stdin_and_reaps_a_cooperative_child";
const READY: &str = "petrina-fixture-ready";
const START: Duration = Duration::from_secs(10);
const IO: Duration = Duration::from_secs(2);

fn reap_fixture(child: &mut Child) -> bool {
    drop(child.stdin.take());
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    let _ = child.kill();
    let deadline = Instant::now() + IO;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
}
struct PreparationOwner(Option<Child>);
impl Drop for PreparationOwner {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            if !reap_fixture(child) {
                eprintln!("private actor cleanup was not confirmed");
            }
        }
    }
}

/// Runs only in a fixture's child test executable. Its parent alone supplies this private mode and address.
pub fn child_entry() -> bool {
    let Ok(mode) = std::env::var("PETRINA_TEST_SHELL_CHILD") else {
        return false;
    };
    assert!(["hold", "handoff", "cooperative"].contains(&mode.as_str()));
    let address: SocketAddr = std::env::var("PETRINA_TEST_SHELL_CONTROL")
        .unwrap()
        .parse()
        .unwrap();
    let mut control =
        TcpStream::connect_timeout(&address, START).expect("fixture connects to its owner");
    control
        .write_all(&std::process::id().to_be_bytes())
        .unwrap();
    thread::spawn(move || loop {
        let mut request = [0];
        if control.read_exact(&mut request).is_err() {
            std::process::exit(0);
        }
        match request[0] {
            b'P' => {
                if control.write_all(b"P").is_err() {
                    std::process::exit(0);
                }
            }
            b'Q' => std::process::exit(0),
            _ => std::process::exit(2),
        }
    });
    // A final guard for a crashed test owner. Normal tests stop through stdin, the owned handle or the control.
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(30));
        std::process::exit(3);
    });
    println!("\n{READY}");
    io::stdout().flush().unwrap();
    io::stdin().lock().read_to_end(&mut Vec::new()).unwrap();
    if mode == "cooperative" {
        return true;
    }
    if mode == "handoff" {
        println!("{{\"type\":\"handoff\",\"active\":true}}");
        io::stdout().flush().unwrap();
    }
    loop {
        thread::park();
    }
}

pub struct Control {
    stream: TcpStream,
    pub pid: u32,
    closed: bool,
}
impl Control {
    pub fn go(&mut self) {
        self.stream
            .write_all(b"G")
            .expect("prepared actor can be released");
    }
    pub fn ready(&mut self) {
        let mut receipt = [0];
        self.stream
            .read_exact(&mut receipt)
            .expect("outer completed its startup");
        assert_eq!(receipt, *b"R");
        self.closed = true;
    }
    /// A live response proves the child kept executing after the desktop process handed it off.
    pub fn ping(&mut self) {
        self.stream
            .write_all(b"P")
            .expect("controlled child is reachable");
        let mut reply = [0];
        self.stream
            .read_exact(&mut reply)
            .expect("controlled child answers");
        assert_eq!(reply, *b"P");
    }
    pub fn stopped(&mut self) {
        let mut byte = [0];
        match self.stream.read(&mut byte) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::BrokenPipe
                ) => {}
            other => panic!(
                "controlled child {} must close its control when stopped: {other:?}",
                self.pid
            ),
        }
        self.closed = true;
    }
    pub fn quit(&mut self) {
        self.stream
            .write_all(b"Q")
            .expect("owner can stop its controlled child");
        self.stopped();
    }
}

pub fn announce_outer_ready(address: &str) {
    let address: SocketAddr = address.parse().unwrap();
    let mut stream = TcpStream::connect_timeout(&address, START).expect("outer readiness listener");
    stream.write_all(&std::process::id().to_be_bytes()).unwrap();
    stream.write_all(b"R").unwrap();
}
impl Drop for Control {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.stream.write_all(b"Q");
        }
    }
}

pub struct Listener(TcpListener);
impl Listener {
    pub fn new() -> Self {
        let socket = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("private fixture listener");
        socket.set_nonblocking(true).unwrap();
        Self(socket)
    }
    pub fn address(&self) -> String {
        self.0.local_addr().unwrap().to_string()
    }
    pub fn accept(&self) -> io::Result<Control> {
        let deadline = Instant::now() + START;
        loop {
            match self.0.accept() {
                Ok((mut stream, _)) => {
                    // Do not inherit the listener's nonblocking mode: accepted-socket behavior differs by OS.
                    stream.set_nonblocking(false)?;
                    stream.set_read_timeout(Some(IO))?;
                    stream.set_write_timeout(Some(IO))?;
                    let mut pid = [0; 4];
                    stream.read_exact(&mut pid)?;
                    return Ok(Control {
                        stream,
                        pid: u32::from_be_bytes(pid),
                        closed: false,
                    });
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(error),
            }
        }
    }
}

/// A child owned by a fixture until the production lifecycle function receives it.
pub fn start_child(mode: &str, address: &str) -> Started {
    let mut command = Command::new(std::env::current_exe().expect("test executable path"));
    command
        .args(["--exact", CHILD_TEST, "--nocapture"])
        .env("PETRINA_TEST_SHELL_CHILD", mode)
        .env("PETRINA_TEST_SHELL_CONTROL", address)
        .env_remove("PETRINA_OUTER_EXIT_CHILD_CASE")
        .env_remove("PETRINA_OUTER_CONTROL_ADDRESS")
        .env_remove("PETRINA_OUTER_READY_ADDRESS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = spawn_command(&mut command).expect("controlled child starts");
    let handoff = Arc::new(AtomicBool::new(false));
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let line = child.stdin.take();
    let reader_handoff = Arc::clone(&handoff);
    let (ready, received) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        while stdout.read_line(&mut line).unwrap_or(0) > 0 {
            if line.trim() == READY {
                let _ = ready.send(());
                break;
            }
            line.clear();
        }
        read_handoff_events(stdout, reader_handoff);
    });
    if received.recv_timeout(START).is_err() {
        if !reap_fixture(&mut child) {
            eprintln!("controlled child cleanup was not confirmed");
        }
        panic!("controlled child did not announce readiness");
    }
    Started {
        owner: ChildOwner::controlled(child, line, handoff),
        hello: "ready".into(),
    }
}

pub fn controlled_child(mode: &str) -> (Started, Control) {
    let listener = Listener::new();
    let mut started = start_child(mode, &listener.address());
    match listener.accept() {
        Ok(control) if started.owner.child.id() == control.pid => (started, control),
        Ok(_) => {
            if !reap_fixture(&mut started.owner.child) {
                eprintln!("controlled child cleanup was not confirmed");
            }
            panic!("a different process connected to the fixture's listener");
        }
        Err(error) => {
            if !reap_fixture(&mut started.owner.child) {
                eprintln!("controlled child cleanup was not confirmed");
            }
            panic!("controlled child did not connect: {error}");
        }
    }
}

/// Reap a fixture's own outer process on assertion failure as well as success.
pub struct OwnedOuter(pub Child);
impl Drop for OwnedOuter {
    fn drop(&mut self) {
        if !reap_fixture(&mut self.0) {
            eprintln!("private outer cleanup was not confirmed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine_process::{
        open_child, stop, ChildObservation, EngineConnection, StartupFailure, START_TIMEOUT,
    };
    const ACTOR: &str = "test_process::tests::startup_actor";
    const PREPARED: &str = "petrina-startup-actor-prepared";

    fn actor_command(mode: &str, address: &str, helper: Option<&str>) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", ACTOR, "--nocapture"])
            .env("PETRINA_STARTUP_ACTOR", mode)
            .env("PETRINA_STARTUP_CONTROL", address)
            .env_remove("PETRINA_TEST_SHELL_CHILD")
            .env_remove("PETRINA_TEST_SHELL_CONTROL")
            .env_remove("PETRINA_OUTER_EXIT_CHILD_CASE")
            .env_remove("PETRINA_OUTER_CONTROL_ADDRESS")
            .env_remove("PETRINA_OUTER_READY_ADDRESS");
        if let Some(helper) = helper {
            command.env("PETRINA_STARTUP_HELPER", helper);
        } else {
            command.env_remove("PETRINA_STARTUP_HELPER");
        }
        command
    }

    #[cfg(windows)]
    fn clear_std_handle_inheritance() {
        use std::os::windows::io::{AsRawHandle, RawHandle};
        const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
        #[link(name = "kernel32")]
        extern "system" {
            fn SetHandleInformation(h_object: RawHandle, dw_mask: u32, dw_flags: u32) -> i32;
        }
        for handle in [io::stdin().as_raw_handle(), io::stdout().as_raw_handle()] {
            // SAFETY: `stdin` and `stdout` are live Win32 handles owned by this fixture child;
            // clearing `HANDLE_FLAG_INHERIT` keeps `CreateProcessW(..., bInheritHandles = TRUE)`
            // from leaking `stdout` or `stdin` into `stderr-holder` when only `stderr` is inherited.
            let ok = unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
            assert_ne!(
                ok, 0,
                "clearing HANDLE_FLAG_INHERIT on fixture stdio must succeed"
            );
        }
    }

    #[test]
    fn startup_actor() {
        let Ok(mode) = std::env::var("PETRINA_STARTUP_ACTOR") else {
            return;
        };
        let address: SocketAddr = std::env::var("PETRINA_STARTUP_CONTROL")
            .unwrap()
            .parse()
            .unwrap();
        let mut stream = TcpStream::connect_timeout(&address, START).unwrap();
        stream.write_all(&std::process::id().to_be_bytes()).unwrap();
        let (go, released) = mpsc::channel();
        thread::spawn(move || loop {
            let mut request = [0];
            if stream.read_exact(&mut request).is_err() {
                std::process::exit(0);
            }
            match request[0] {
                b'G' => {
                    let _ = go.send(());
                }
                b'P' => {
                    if stream.write_all(b"P").is_err() {
                        std::process::exit(0);
                    }
                }
                b'Q' => std::process::exit(0),
                _ => std::process::exit(2),
            }
        });
        thread::spawn(|| {
            thread::sleep(Duration::from_secs(30));
            std::process::exit(3);
        });
        if mode == "stderr-holder" {
            loop {
                thread::park();
            }
        }
        if mode == "held-stderr" {
            let helper = std::env::var("PETRINA_STARTUP_HELPER").unwrap();
            #[cfg(windows)]
            clear_std_handle_inheritance();
            // Its private control is independently held by the parent; stderr is the actual inherited pipe.
            #[allow(clippy::zombie_processes)]
            let _helper = actor_command("stderr-holder", &helper, None)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        }
        println!("\n{PREPARED}");
        io::stdout().flush().unwrap();
        released.recv().unwrap();
        match mode.as_str() {
            "eof" | "held-stderr" => std::process::exit(0),
            "blank" => {
                println!();
                io::stdout().flush().unwrap();
            }
            "silent" => {}
            "ready" => {
                println!("{{\"type\":\"ready\",\"address\":\"private-fixture\"}}");
                io::stdout().flush().unwrap();
            }
            "diagnostic" => {
                eprintln!("a private startup diagnostic");
                std::process::exit(0);
            }
            _ => panic!("unknown private startup actor"),
        }
        io::stdin().lock().read_to_end(&mut Vec::new()).unwrap();
        std::process::exit(0);
    }

    fn prepare(mode: &str, helper: Option<&str>) -> (Child, Control) {
        let listener = Listener::new();
        let mut command = actor_command(mode, &listener.address(), helper);
        let mut child = PreparationOwner(Some(
            spawn_command(
                command
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped()),
            )
            .unwrap(),
        ));
        let mut stdout = child.0.as_mut().unwrap().stdout.take().unwrap();
        let (prepared, preparation) = mpsc::channel();
        let reader = thread::spawn(move || {
            // Consume only the fixture/libtest preamble. Byte reads preserve every real subsequent pipe byte.
            let mut line = Vec::new();
            loop {
                let mut byte = [0];
                if stdout.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    if String::from_utf8_lossy(&line).trim() == PREPARED {
                        let _ = prepared.send(stdout);
                        return;
                    }
                    line.clear();
                }
            }
        });
        match preparation.recv_timeout(START) {
            Ok(stdout) => child.0.as_mut().unwrap().stdout = Some(stdout),
            Err(error) => panic!("startup actor preparation failed: {error}"),
        }
        reader.join().unwrap();
        let control = listener
            .accept()
            .expect("actual startup actor is ready before cleanup measurement");
        (child.0.take().unwrap(), control)
    }

    fn begin(
        mode: &str,
        helper: Option<&str>,
    ) -> (
        mpsc::Receiver<Result<super::Started, crate::engine_process::StartupFailure>>,
        Control,
        thread::JoinHandle<()>,
    ) {
        let (child, control) = prepare(mode, helper);
        let (done, result) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = done.send(open_child(child, START_TIMEOUT));
        });
        (result, control, worker)
    }

    #[test]
    fn startup_deadline_closes_its_prepared_silent_child_without_extending_the_read_budget() {
        assert_eq!(START_TIMEOUT, Duration::from_secs(30));
        let (child, mut control) = prepare("silent", None);
        control.ping();
        control.go();
        let budget = Duration::from_millis(100);
        let began = Instant::now();
        let failure = match open_child(child, budget) {
            Err(failure) => failure,
            Ok(_) => panic!("silent actor cannot be ready"),
        };
        assert!(began.elapsed() >= budget);
        assert!(began.elapsed() < Duration::from_secs(3));
        assert!(failure.message.contains("did not start within"));
        assert!(failure.remaining.is_none());
        control.stopped();
    }

    #[test]
    fn blank_start_closes_actual_stdin_and_confirms_its_child_exit() {
        let (result, mut control, worker) = begin("blank", None);
        control.ping();
        let began = Instant::now();
        control.go();
        let failure = match result.recv_timeout(Duration::from_secs(3)).unwrap() {
            Err(failure) => failure,
            Ok(_) => panic!("blank start must fail"),
        };
        assert!(failure.message.contains("stopped while starting"));
        assert!(
            failure.remaining.is_none(),
            "actual child exit and reader completion are confirmed"
        );
        assert!(began.elapsed() < Duration::from_secs(3));
        control.stopped();
        worker.join().unwrap();
    }

    #[test]
    fn eof_and_diagnostic_starts_finish_without_an_open_input_or_unbounded_join() {
        for mode in ["eof", "diagnostic"] {
            let (result, mut control, worker) = begin(mode, None);
            control.ping();
            control.go();
            let failure = match result.recv_timeout(Duration::from_secs(3)).unwrap() {
                Err(failure) => failure,
                Ok(_) => panic!("ended actor cannot be ready"),
            };
            assert!(failure.remaining.is_none());
            assert_eq!(
                failure.message.contains("a private startup diagnostic"),
                mode == "diagnostic"
            );
            control.stopped();
            worker.join().unwrap();
        }
    }

    #[test]
    fn successful_start_keeps_its_real_line_then_stops_cooperatively() {
        let (result, mut control, worker) = begin("ready", None);
        control.ping();
        control.go();
        let started = match result.recv_timeout(Duration::from_secs(3)).unwrap() {
            Ok(started) => started,
            Err(failure) => panic!("{}", failure.message),
        };
        assert_eq!(
            started.hello,
            r#"{"type":"ready","address":"private-fixture"}"#
        );
        stop(started).unwrap_or_else(|_| panic!("cooperative cleanup is confirmed"));
        control.stopped();
        worker.join().unwrap();
    }

    #[test]
    fn an_exited_handoff_owner_cannot_keep_reusing_its_obsolete_address() {
        let (result, mut control, worker) = begin("ready", None);
        control.ping();
        control.go();
        let mut started = match result.recv_timeout(Duration::from_secs(3)).unwrap() {
            Ok(started) => started,
            Err(failure) => panic!("{}", failure.message),
        };
        started
            .owner
            .handoff
            .store(true, std::sync::atomic::Ordering::Release);
        control.quit();
        let deadline = Instant::now() + IO;
        while started.owner.observe() != ChildObservation::Exited {
            assert!(
                Instant::now() < deadline,
                "the privately released child actually exits"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let connection = EngineConnection::default();
        assert!(connection.connect_with(false, || Ok(started)).is_ok());
        let mut called = false;
        let next = connection.connect_with(false, || {
            called = true;
            Err(StartupFailure {
                message: "replacement starter reached".into(),
                remaining: None,
            })
        });
        assert!(called, "a confirmed ended owner cannot block a later start");
        assert_eq!(next.unwrap_err(), "replacement starter reached");
        worker.join().unwrap();
    }

    #[test]
    fn inherited_stderr_is_bounded_and_independent_release_completes_retained_cleanup() {
        let helper = Listener::new();
        let (result, mut leader, worker) = begin("held-stderr", Some(&helper.address()));
        let mut helper = helper.accept().expect("separate stderr holder is ready");
        leader.ping();
        helper.ping();
        let began = Instant::now();
        leader.go();
        let mut failure = match result.recv_timeout(Duration::from_secs(3)).unwrap() {
            Err(failure) => failure,
            Ok(_) => panic!("EOF start must fail"),
        };
        assert!(began.elapsed() < Duration::from_secs(3));
        assert!(failure.message.contains("output pipes have not closed"));
        let retained = failure
            .remaining
            .as_mut()
            .expect("incomplete pipe cleanup retains its actual owner");
        assert_eq!(retained.observe(), ChildObservation::Exited);
        leader.stopped();
        helper.ping();
        let connection = EngineConnection::default();
        assert!(connection.connect_with(false, || Err(failure)).is_err());
        let starts = std::sync::atomic::AtomicUsize::new(0);
        assert!(connection
            .connect_with(false, || {
                starts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                panic!("a competitor must not start while the real pipe is still held");
            })
            .is_err());
        assert_eq!(starts.load(std::sync::atomic::Ordering::SeqCst), 0);
        helper.quit();
        let next = connection.connect_with(false, || {
            starts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(StartupFailure {
                message: "the next explicit starter was called".into(),
                remaining: None,
            })
        });
        assert_eq!(next.unwrap_err(), "the next explicit starter was called");
        assert_eq!(starts.load(std::sync::atomic::Ordering::SeqCst), 1);
        worker.join().unwrap();
    }
}
