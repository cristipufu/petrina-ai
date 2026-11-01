import { createServer, type Socket } from "node:net";
import { SLOW } from "./slow.js";
import { CLEANUP_MS } from "./command-budgets.js";
import { createGuardianLease, guardianWorkerMonitor } from "./process-lease-guardian.js";

export interface ProcessLeaseOptions {
  /** POSIX stop fixtures whose actors can be paused by the operation under test. */
  guardian?: "node";
}

export interface ProcessLeaseProgramOptions {
  /** Only for actors whose main thread deliberately blocks the event loop. */
  monitor?: "worker";
}

export interface LeasedActor {
  readonly id: number;
  readonly pid: number;
}

/** An out-of-band lifetime for fixture actors, independent of the cleanup being tested. */
export interface ProcessLease {
  /** No actor body runs before its owner answers. Losing that connection ends the actor. */
  program(body: string, options?: ProcessLeaseProgramOptions): string;
  /** Refuse late actors and disconnect existing actors; safe to call more than once. */
  close(): Promise<void>;
}

/** A process lease that also tracks admitted actor instances across OS PID reuse. */
export interface TrackedProcessLease extends ProcessLease {
  actors(): readonly LeasedActor[];
  isAlive(actor: LeasedActor): boolean;
  isPidAlive(pid: number): boolean;
}

interface InternalActor extends LeasedActor {
  connected: boolean;
  confirmedExited: boolean;
}

const probeExited = (record: InternalActor): boolean => {
  if (record.confirmedExited) return true;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      record.confirmedExited = true;
      return true;
    }
    return false;
  }
};

/**
 * A private loopback connection survives reparenting and detached process groups. When a case fails,
 * closing the lease ends its actors; when a worker dies, the OS closes its connections instead.
 * The optional Worker monitor signals only its own current process, never another or saved PID.
 * No actor lifetime timer can masquerade as the subject's successful cleanup.
 * Actors must use this wrapper before starting children; wrap each long-lived child as well.
 */
export async function createProcessLease(): Promise<TrackedProcessLease>;
export async function createProcessLease(options: ProcessLeaseOptions): Promise<ProcessLease>;
export async function createProcessLease(options: ProcessLeaseOptions = {}): Promise<ProcessLease | TrackedProcessLease> {
  if (options.guardian !== undefined) {
    if (options.guardian !== "node") throw new RangeError("Unknown fixture lease guardian");
    return createGuardianLease((body, port, token) => workerMonitoredProgram(body, port, token, true));
  }
  const token = crypto.randomUUID();
  const sockets = new Set<Socket>();
  const records = new Map<number, InternalActor>();
  const bySocket = new Map<Socket, InternalActor>();
  let nextId = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer(socket => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      const record = bySocket.get(socket);
      if (!record) return;
      bySocket.delete(socket);
      record.connected = false;
      if (probeExited(record)) return;
      let attempts = 0;
      const timer = setInterval(() => {
        if (probeExited(record) || ++attempts >= 50) clearInterval(timer);
      }, 10);
      timer.unref();
    });
    let input = "";
    let admitted = false;
    socket.on("data", chunk => {
      input += chunk.toString("utf8");
      if (admitted || input.length > token.length + 32) {
        socket.destroy();
        return;
      }
      const end = input.indexOf("\n");
      if (end < 0) {
        if (!input.startsWith(token.slice(0, Math.min(input.length, token.length)))) socket.destroy();
        return;
      }
      if (end !== input.length - 1) {
        socket.destroy();
        return;
      }
      const frame = input.slice(0, end);
      const sep = frame.lastIndexOf(":");
      const pid = sep > 0 ? Number(frame.slice(sep + 1)) : NaN;
      if (sep !== token.length || frame.slice(0, sep) !== token || !Number.isSafeInteger(pid) || pid <= 0) {
        socket.destroy();
        return;
      }
      admitted = true;
      const record: InternalActor = { id: ++nextId, pid, connected: true, confirmedExited: false };
      records.set(record.id, record);
      bySocket.set(socket, record);
      socket.write(`${token}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The fixture process owner has no loopback address");
  }
  const port = address.port;
  const isAlive = (actor: LeasedActor): boolean => {
    const record = records.get(actor.id);
    return !!record && !probeExited(record);
  };
  return {
    program(body, options) {
      if (options?.monitor === "worker") return workerMonitoredProgram(body, port, token);
      if (options?.monitor !== undefined) throw new RangeError("Unknown fixture lease monitor");
      return `await (async () => {
  const { createConnection } = require("node:net");
  const connection = createConnection({ host: "127.0.0.1", port: ${port} });
  const ended = () => process.exit(78);
  connection.on("error", ended);
  connection.on("end", ended);
  connection.on("close", ended);
  await new Promise(resolve => {
    const timeout = setTimeout(ended, ${30_000 * SLOW});
    let answer = "";
    connection.once("connect", () => connection.write(${JSON.stringify(`${token}:`)} + process.pid + "\\n"));
    connection.on("data", chunk => {
      answer += chunk.toString("utf8");
      if (answer === ${JSON.stringify(`${token}\n`)}) { clearTimeout(timeout); resolve(); }
      else if (answer.length >= ${token.length + 1} || !${JSON.stringify(`${token}\n`)}.startsWith(answer)) ended();
    });
  });
  await (async () => { ${body}\n})();
  process.exit(0);
})();`;
    },
    actors: () => [...records.values()].map(({ id, pid }) => ({ id, pid })),
    isAlive,
    isPidAlive(pid) {
      for (const record of records.values()) {
        if (record.pid === pid && !probeExited(record)) return true;
      }
      return false;
    },
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        closed = true;
        for (const socket of sockets) socket.destroy();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

/** The actor body stays on its main thread; only the existing lease socket moves to a Worker. */
function workerMonitoredProgram(body: string, port: number, token: string, guardian = false): string {
  const monitor = guardian ? guardianWorkerMonitor() : `
const { parentPort, workerData } = require("node:worker_threads");
const { createConnection } = require("node:net");
let disarmed = false, acknowledged = false;
// This is the currently executing process, never a saved or supplied actor identity.
// Worker process.exit alone would stop only this thread and leave a blocked main alive.
const lost = () => { if (!disarmed) process.kill(process.pid, "SIGKILL"); };
process.on("uncaughtException", lost);
process.on("unhandledRejection", lost);
process.on("exit", lost);
const connection = createConnection({ host: workerData.host, port: workerData.port });
connection.on("error", lost);
connection.on("end", lost);
connection.on("close", lost);
const timeout = setTimeout(lost, ${30_000 * SLOW});
let answer = "";
connection.once("connect", () => connection.write(workerData.token + ":" + process.pid + "\\n"));
connection.on("data", chunk => {
  answer += chunk.toString("utf8");
  if (answer === workerData.token + "\\n" && !acknowledged) {
    acknowledged = true; clearTimeout(timeout); parentPort.postMessage("ready");
  } else if (answer.length >= workerData.token.length + 1 || !(workerData.token + "\\n").startsWith(answer)) lost();
});
parentPort.on("message", message => {
  if (message !== "disarm" || !acknowledged) { lost(); return; }
  disarmed = true; clearTimeout(timeout); connection.destroy(); parentPort.close();
});`;
  return `await (async () => {
  const { Worker } = require("node:worker_threads");
  const monitor = new Worker(${JSON.stringify(monitor)}, { eval: true, workerData: { host: "127.0.0.1", port: ${port}, token: ${JSON.stringify(token)} } });
  let disarming = false, bodyStarted = false, ready = false;
  const ended = new Promise((resolve, reject) => {
    monitor.once("error", error => { reject(error); if (bodyStarted && !disarming) process.exit(78); });
    monitor.once("exit", code => {
      if (disarming && code === 0) resolve();
      else { reject(new Error("Fixture lease monitor ended unexpectedly with " + code)); if (bodyStarted && !disarming) process.exit(78); }
    });
  });
  void ended.catch(() => {});
  const admitted = new Promise((resolve, reject) => {
    monitor.on("message", message => {
      if (message === "ready" && !ready) { ready = true; resolve(); }
      else { reject(new Error("Fixture lease monitor gave an invalid acknowledgment")); if (bodyStarted && !disarming) process.exit(78); }
    });
    void ended.then(() => reject(new Error("Fixture lease monitor ended before admission")), reject);
  });
  let handshakeTimer, cleanupTimer, failure, cleanupFailure;
  try {
    await Promise.race([admitted, new Promise((_, reject) => { handshakeTimer = setTimeout(() => reject(new Error("Fixture lease monitor gave no acknowledgment")), ${30_000 * SLOW}); })]);
    clearTimeout(handshakeTimer);
    bodyStarted = true;
    await (async () => { ${body}\n})();
  } catch (error) { failure = { error }; }
  finally {
    clearTimeout(handshakeTimer);
    try {
      disarming = true; monitor.postMessage("disarm");
      await Promise.race([ended, new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("Fixture lease monitor did not settle; cleanup is unconfirmed")), ${CLEANUP_MS * SLOW}); })]);
    } catch (error) { cleanupFailure = { error }; void monitor.terminate().catch(() => {}); }
    finally { clearTimeout(cleanupTimer); }
  }
  if (cleanupFailure) {
    if (failure) throw new AggregateError([failure.error, cleanupFailure.error], "Fixture body and lease monitor cleanup failed");
    throw cleanupFailure.error;
  }
  if (failure) throw failure.error;
  process.exit(0);
})();`;
}
