//! Private desktop lifecycle fixtures. Real child handles and loopback controls, with no shell or PID killing.
use super::{read_handoff_events, Started};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const CHILD_TEST: &str = "tests::ordinary_quit_closes_stdin_and_reaps_a_cooperative_child";
const READY: &str = "petrina-fixture-ready";
const START: Duration = Duration::from_secs(10);
const IO: Duration = Duration::from_secs(2);

/// Runs only in a fixture's child test executable. Its parent alone supplies this private mode and address.
pub fn child_entry() -> bool {
    let Ok(mode) = std::env::var("PETRINA_TEST_SHELL_CHILD") else { return false; };
    assert!(["hold", "handoff", "cooperative"].contains(&mode.as_str()));
    let address: SocketAddr = std::env::var("PETRINA_TEST_SHELL_CONTROL").unwrap().parse().unwrap();
    let mut control = TcpStream::connect_timeout(&address, START).expect("fixture connects to its owner");
    control.write_all(&std::process::id().to_be_bytes()).unwrap();
    thread::spawn(move || loop {
        let mut request = [0];
        if control.read_exact(&mut request).is_err() { std::process::exit(0); }
        match request[0] {
            b'P' => { if control.write_all(b"P").is_err() { std::process::exit(0); } }
            b'Q' => std::process::exit(0),
            _ => std::process::exit(2),
        }
    });
    // A final guard for a crashed test owner. Normal tests stop through stdin, the owned handle or the control.
    thread::spawn(|| { thread::sleep(Duration::from_secs(30)); std::process::exit(3); });
    println!("\n{READY}");
    io::stdout().flush().unwrap();
    io::stdin().lock().read_to_end(&mut Vec::new()).unwrap();
    if mode == "cooperative" { return true; }
    if mode == "handoff" {
        println!("{{\"type\":\"handoff\",\"active\":true}}");
        io::stdout().flush().unwrap();
    }
    loop { thread::park(); }
}

pub struct Control { stream: TcpStream, pub pid: u32, closed: bool }
impl Control {
    /// A live response proves the child kept executing after the desktop process handed it off.
    pub fn ping(&mut self) {
        self.stream.write_all(b"P").expect("controlled child is reachable");
        let mut reply = [0];
        self.stream.read_exact(&mut reply).expect("controlled child answers");
        assert_eq!(reply, *b"P");
    }
    pub fn stopped(&mut self) {
        let mut byte = [0];
        match self.stream.read(&mut byte) {
            Ok(0) => {}
            Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted | io::ErrorKind::BrokenPipe) => {}
            other => panic!("controlled child {} must close its control when stopped: {other:?}", self.pid),
        }
        self.closed = true;
    }
    pub fn quit(&mut self) {
        self.stream.write_all(b"Q").expect("owner can stop its controlled child");
        self.stopped();
    }
}
impl Drop for Control {
    fn drop(&mut self) { if !self.closed { let _ = self.stream.write_all(b"Q"); } }
}

pub struct Listener(TcpListener);
impl Listener {
    pub fn new() -> Self {
        let socket = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("private fixture listener");
        socket.set_nonblocking(true).unwrap();
        Self(socket)
    }
    pub fn address(&self) -> String { self.0.local_addr().unwrap().to_string() }
    pub fn accept(&self) -> io::Result<Control> {
        let deadline = Instant::now() + START;
        loop {
            match self.0.accept() {
                Ok((mut stream, _)) => {
                    // Do not inherit the listener's nonblocking mode: accepted-socket behavior differs by OS.
                    stream.set_nonblocking(false)?;
                    stream.set_read_timeout(Some(IO))?;
                    stream.set_write_timeout(Some(IO))?;
                    let mut pid = [0; 4]; stream.read_exact(&mut pid)?;
                    return Ok(Control { stream, pid: u32::from_be_bytes(pid), closed: false });
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Err(error) => return Err(error),
            }
        }
    }
}

/// A child owned by a fixture until the production lifecycle function receives it.
pub fn start_child(mode: &str, address: &str) -> Started {
    let mut command = Command::new(std::env::current_exe().expect("test executable path"));
    command.args(["--exact", CHILD_TEST, "--nocapture"])
        .env("PETRINA_TEST_SHELL_CHILD", mode).env("PETRINA_TEST_SHELL_CONTROL", address)
        .env_remove("PETRINA_OUTER_EXIT_CHILD_CASE").env_remove("PETRINA_OUTER_CONTROL_ADDRESS")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().expect("controlled child starts");
    let handoff = Arc::new(AtomicBool::new(false));
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let line = child.stdin.take();
    let reader_handoff = Arc::clone(&handoff);
    let (ready, received) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        while stdout.read_line(&mut line).unwrap_or(0) > 0 {
            if line.trim() == READY { let _ = ready.send(()); break; }
            line.clear();
        }
        read_handoff_events(stdout, reader_handoff);
    });
    if received.recv_timeout(START).is_err() {
        let _ = child.kill(); let _ = child.wait();
        panic!("controlled child did not announce readiness");
    }
    Started { child, line, hello: "ready".into(), handoff }
}

pub fn controlled_child(mode: &str) -> (Started, Control) {
    let listener = Listener::new();
    let mut started = start_child(mode, &listener.address());
    match listener.accept() {
        Ok(control) if started.child.id() == control.pid => (started, control),
        Ok(_) => {
            let _ = started.child.kill(); let _ = started.child.wait();
            panic!("a different process connected to the fixture's listener");
        }
        Err(error) => {
            let _ = started.child.kill(); let _ = started.child.wait();
            panic!("controlled child did not connect: {error}");
        }
    }
}

/// Reap a fixture's own outer process on assertion failure as well as success.
pub struct OwnedOuter(pub Child);
impl Drop for OwnedOuter {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) { let _ = self.0.kill(); }
        let _ = self.0.wait();
    }
}
