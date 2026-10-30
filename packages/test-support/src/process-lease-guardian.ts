import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureOperations } from "./fixture-operations.js";
import { registerFixtureRoot } from "./fixture-retention.js";
import { tempDir, waitFor } from "./fixtures.js";
import { removeFixtureRoot } from "./fixture-roots.js";
import { CLEANUP_MS } from "./command-budgets.js";
import { currentSlow, SLOW } from "./slow.js";
import type { ProcessLease } from "./process-lease.js";

/** The actor connection is the current ownership record, never a persisted PID list. */
export async function createGuardianLease(
  workerProgram: (body: string, port: number, token: string) => string,
): Promise<ProcessLease> {
  if (process.platform === "win32") throw new Error("The paused-actor lease guardian requires POSIX signals");
  const node = Bun.which("node");
  if (!node) throw new Error("The fixture guardian requires the repository's declared native Node.js prerequisite");
  const root = tempDir("petrina-lease-guardian-");
  registerFixtureRoot(root);
  const token = crypto.randomUUID();
  const program = join(root, "guardian.mjs");
  let accepting = true;
  let child: ReturnType<typeof spawn> | undefined;
  let completion: Promise<void> | undefined;
  let ready: { port: number } | undefined;
  const owner = new FixtureOperations({
    label: `Node lease guardian at ${root}`,
    allowanceMs: CLEANUP_MS * currentSlow(),
    arm(fire, ms) {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
    stop() {
      accepting = false;
      // Do not kill the only guardian while its current actor registrations remain unresolved.
      child?.stdin?.end();
      return completion;
    },
    dispose: () => removeFixtureRoot(root),
  });
  try {
    writeFileSync(program, GUARDIAN_PROGRAM);
    const running = owner.run(async () => {
      if (!accepting) throw new Error("Guardian closed before native admission");
      const actual = (child = spawn(node, [program, token], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      }));
      let output = "";
      let stderr = "";
      let out = false;
      let err = false;
      let failure: { error: unknown } | undefined;
      completion = new Promise<void>((resolve, reject) => {
        actual.once("error", (error) => {
          failure ??= { error };
        });
        actual.stdin!.on("error", (error) => {
          failure ??= { error };
        });
        actual.stdout!.on("data", (chunk) => {
          output += chunk.toString("utf8");
          if (output.length > 4_096) {
            failure ??= { error: new Error("Guardian readiness exceeded its protocol bound") };
            actual.stdin!.end();
            return;
          }
          for (let end; (end = output.indexOf("\n")) >= 0; ) {
            const line = output.slice(0, end);
            output = output.slice(end + 1);
            try {
              const value: unknown = JSON.parse(line);
              const isValidReady =
                value &&
                typeof value === "object" &&
                "kind" in value &&
                value.kind === "ready" &&
                "port" in value &&
                Number.isInteger(value.port) &&
                (value.port as number) > 0 &&
                (value.port as number) <= 65_535 &&
                !ready;
              if (!isValidReady) throw new Error("Invalid guardian readiness");
              ready = { port: value.port as number };
            } catch (error) {
              failure ??= { error };
              actual.stdin!.end();
            }
          }
        });
        actual.stdout!.once("end", () => {
          out = true;
        });
        actual.stderr!.on("data", (chunk) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
        });
        actual.stderr!.once("end", () => {
          err = true;
        });
        for (const stream of [actual.stdout!, actual.stderr!]) {
          stream.once("error", (error) => {
            failure ??= { error };
          });
        }
        actual.once("close", (code, signal) => {
          if (failure) reject(failure.error);
          else if (!out || !err) reject(new Error("Guardian output did not confirm EOF"));
          else if (code !== 0 || signal !== null) {
            reject(new Error(`Node guardian failed (${code ?? signal}): ${stderr}`));
          } else resolve();
        });
      });
      void completion.catch(() => undefined);
      if (!accepting) actual.stdin!.end();
      await completion;
    });
    void running.catch(() => undefined);
    const address = await waitFor(
      () => ready,
      "the independently owned Node lease guardian",
      undefined,
      { during: running },
    );
    return {
      program(body, options) {
        if (options?.monitor === "worker") return workerProgram(body, address.port, token);
        if (options?.monitor !== undefined) throw new RangeError("Unknown fixture lease monitor");
        return guardianActorProgram(body, address.port, token);
      },
      close: () => owner.close(),
    };
  } catch (error) {
    try {
      await owner.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Guardian setup and cleanup failed");
    }
    throw error;
  }
}

function guardianActorProgram(body: string, port: number, token: string): string {
  return `await (async () => {
  const { createConnection } = require("node:net");
  const connection = createConnection({ host: "127.0.0.1", port: ${port} });
  const ended = () => process.exit(78);
  connection.on("error", ended);
  connection.on("end", ended);
  connection.on("close", ended);
  await new Promise(resolve => {
    const timeout = setTimeout(ended, ${30_000 * SLOW});
    let input = "", admitted = false;
    connection.once("connect", () =>
      connection.write(JSON.stringify({ version: 1, token: ${JSON.stringify(token)}, pid: process.pid }) + "\\n"),
    );
    connection.on("data", chunk => {
      input += chunk.toString("utf8");
      if (input.length > 4096) ended();
      for (let end; (end = input.indexOf("\\n")) >= 0;) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { ended(); return; }
        if (!admitted && frame && frame.version === 1 && frame.token === ${JSON.stringify(token)} && frame.kind === "admitted") {
          admitted = true;
          clearTimeout(timeout);
          resolve();
        } else {
          // A subsequent authenticated stop ends this actor itself.
          ended();
        }
      }
    });
  });
  await (async () => { ${body}\n})();
  process.exit(0);
})();`;
}

/** Only the lease protocol differs; the existing Worker admission/body/settlement owner is reused. */
export function guardianWorkerMonitor(): string {
  return (
    String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createConnection } = require("node:net");
let disarmed = false, acknowledged = false;
const lost = () => { if (!disarmed) process.kill(process.pid, "SIGKILL"); };
process.on("uncaughtException", lost);
process.on("unhandledRejection", lost);
process.on("exit", lost);
const connection = createConnection({ host: workerData.host, port: workerData.port });
connection.on("error", lost);
connection.on("end", lost);
connection.on("close", lost);
const timeout = setTimeout(lost, ` +
    30_000 * SLOW +
    String.raw`);
let input = "";
connection.once("connect", () =>
  connection.write(JSON.stringify({ version: 1, token: workerData.token, pid: process.pid }) + "\n"),
);
connection.on("data", chunk => {
  input += chunk.toString("utf8");
  if (input.length > 4096) lost();
  for (let end; (end = input.indexOf("\n")) >= 0;) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    let frame;
    try { frame = JSON.parse(line); } catch { lost(); return; }
    if (!acknowledged && frame && frame.version === 1 && frame.token === workerData.token && frame.kind === "admitted") {
      acknowledged = true;
      clearTimeout(timeout);
      parentPort.postMessage("ready");
    } else {
      lost();
    }
  }
});
parentPort.on("message", message => {
  if (message !== "disarm" || !acknowledged) { lost(); return; }
  disarmed = true;
  clearTimeout(timeout);
  connection.destroy();
  parentPort.close();
});`
  );
}

// Raw source avoids another quoting layer for Node's framed JSON/newline protocol.
const GUARDIAN_PROGRAM = String.raw`import { createServer } from "node:net";
if (process.versions.bun) throw new Error("The paused-actor guardian requires native Node.js");
const token = process.argv[2], actors = new Map(), connections = new Set();
let closing = false, listening = false, serverClosed = false, timer, failed = false;
const ended = () => {
  if (!serverClosed || connections.size) return;
  clearInterval(timer);
  process.stdin.destroy();
  process.exitCode = failed ? 1 : 0;
};
const stopActors = () => {
  for (const [socket, actor] of actors) {
    if (socket.destroyed || socket.readableEnded) continue;
    try {
      process.kill(actor.pid, "SIGCONT");
    } catch (error) {
      // An exited actor can leave its final socket event queued. Keep that registration
      // until EOF/close; ESRCH neither confirms native collection nor names a new target.
      if (error?.code === "ESRCH") continue;
      failed = true;
    }
    if (!actor.stopSent) {
      actor.stopSent = true;
      socket.write(JSON.stringify({ version: 1, token, kind: "stop" }) + "\n");
    }
  }
};
const closeServer = () => {
  if (!listening) return;
  listening = false;
  server.close(error => {
    if (error) failed = true;
    serverClosed = true;
    ended();
  });
};
const close = () => {
  if (closing) return;
  closing = true;
  closeServer();
  for (const socket of connections) if (!actors.has(socket)) socket.destroy();
  stopActors();
  if (connections.size) timer = setInterval(stopActors, 50);
  ended();
};
const server = createServer(socket => {
  if (closing) { socket.destroy(); return; }
  connections.add(socket);
  // An actor forced by the subject can reset its socket. Channel closure retires this
  // live registration only; native actor termination is checked by the caller.
  socket.on("error", () => socket.destroy());
  socket.on("end", () => { actors.delete(socket); socket.end(); });
  socket.on("close", () => { actors.delete(socket); connections.delete(socket); ended(); });
  let input = "";
  socket.on("data", chunk => {
    input += chunk.toString("utf8");
    if (input.length > 4096 || actors.has(socket)) { failed = true; socket.destroy(); return; }
    const end = input.indexOf("\n");
    if (end < 0) return;
    let frame;
    try { frame = JSON.parse(input.slice(0, end)); } catch { socket.destroy(); return; }
    const invalidFrame =
      closing ||
      input.length !== end + 1 ||
      !frame ||
      typeof frame !== "object" ||
      Object.keys(frame).length !== 3 ||
      frame.version !== 1 ||
      frame.token !== token ||
      !Number.isSafeInteger(frame.pid) ||
      frame.pid <= 0 ||
      frame.pid === process.pid;
    if (invalidFrame) { socket.destroy(); return; }
    actors.set(socket, { pid: frame.pid, stopSent: false });
    socket.write(JSON.stringify({ version: 1, token, kind: "admitted" }) + "\n");
  });
});
process.stdin.on("data", () => {});
process.stdin.once("end", close);
process.stdin.once("error", () => { failed = true; close(); });
process.stdout.on("error", () => { failed = true; close(); });
process.stderr.on("error", () => { failed = true; close(); });
process.once("SIGTERM", close);
process.once("SIGINT", close);
server.once("error", () => {
  failed = true;
  if (listening) {
    close();
  } else {
    closing = true;
    serverClosed = true;
    for (const socket of connections) if (!actors.has(socket)) socket.destroy();
    stopActors();
    ended();
  }
});
server.listen(0, "127.0.0.1", () => {
  listening = true;
  if (closing) { closeServer(); return; }
  const address = server.address();
  if (!address || typeof address === "string") { failed = true; close(); return; }
  process.stdout.write(JSON.stringify({ kind: "ready", port: address.port }) + "\n");
});
`;
