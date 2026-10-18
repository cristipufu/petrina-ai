// Starting and stopping an engine process.
// - `serve`: started by hand in a terminal, on the usual port. Refuses if one is already running.
// - `app`: started by the desktop shell. Steps aside for an engine that is already running, picks
//   a free port, and talks to the shell only over its stdin and stdout: one line on stdout to say
//   it is ready (with its address and key, which never go to a log), and stdin closing means the
//   app is gone, quit or crashed, so the engine stops.

import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Engine, type EngineOptions } from "./engine.js";
import { loginShellPath, mergePath } from "./env.js";
import { claimFolder, type Connection, previousToken, removeConnection, writeConnection } from "./instance.js";
import { OutputLog } from "./log.js";
import { serve } from "./server.js";

export interface LaunchOptions {
  home: string;
  mode: "serve" | "app";
  /** `serve` only: the usual port. An app engine always takes a free one. */
  port?: number;
  /** The built UI to serve, when there is one. */
  ui?: string;
  /** Tests: fake agents and a fake GitHub. */
  engine?: EngineOptions;
  /** Recover the terminal's PATH (app mode). Tests turn it off to start faster. */
  loginShell?: boolean;
  /** Make a new key instead of keeping the last run's. */
  newKey?: boolean;
}

/** What the engine tells the shell. One line of JSON, `type` first. */
export type ShellMessage = { type: "ready" | "running"; owned: boolean; url: string; token: string } | { type: "error"; message: string };

/** How long a stopping engine waits for reviewers, voters and a delivery in flight to hand back. */
const DRAIN_MS = 4 * 60_000;
const ALREADY_RUNNING = "Petrina's engine is already running. Open it with bun run open.";
const BUSY = "Another Petrina engine holds this folder but does not answer. Wait a moment and try again; if it stays like this, stop the other engine";

function tell(message: ShellMessage): void {
  // Written straight to the pipe: the shell reads it, nothing logs it.
  writeSync(1, `${JSON.stringify(message)}\n`);
}

export async function launch(options: LaunchOptions): Promise<void> {
  const { home, mode } = options;
  const app = mode === "app";
  if (app && process.stdout.isTTY) {
    // App mode prints the key for the shell: never onto a terminal.
    process.stderr.write("petrina app is for the desktop app. In a terminal, start the engine with: bun run engine\n");
    process.exit(1);
  }
  const log = new OutputLog(!app);
  log.capture();
  process.on("unhandledRejection", (reason) => console.error("Unhandled error:", reason));

  await mkdir(home, { recursive: true, mode: 0o700 });
  const claim = await claimFolder(home);
  if (claim.kind !== "free") {
    // Stepping aside: the log belongs to the engine that holds the folder.
    log.discard();
    if (app) tell(claim.kind === "running" ? { type: "running", owned: false, url: claim.connection.url, token: claim.connection.token } : { type: "error", message: `${BUSY}.` });
    else process.stderr.write(claim.kind === "running" ? `${ALREADY_RUNNING}\n` : `${BUSY}.\n`);
    process.exit(app && claim.kind === "running" ? 0 : 1);
  }

  const { lock } = claim;
  log.open(join(home, "engine.log"));
  console.log(`${new Date().toISOString()} Petrina engine starting (process ${process.pid}, ${app ? "started by the app" : "started by hand"}, data in ${home})`);

  let engine: Engine | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    // Never hang on the way out: the shell stops waiting after a few seconds anyway.
    setTimeout(() => process.exit(code), 7000).unref();
    try {
      server?.stop(true);
      await engine?.shutdown();
    } catch (error) {
      console.error("While stopping:", error);
    }
    // An app engine takes its connection file with it. One started by hand leaves it, so the next
    // start keeps the key and open browser windows reconnect; a stale file is never trusted alone.
    if (app) removeConnection(home, process.pid);
    lock.release();
    console.log(`${new Date().toISOString()} Petrina engine stopped`);
    log.close();
    process.exit(code);
  };
  process.on("uncaughtException", (error) => {
    console.error("Petrina's engine crashed:", error);
    stop(1);
  });
  // Asked to stop by hand: reviewers and voters in flight start over after a restart, so they get a few minutes
  // to hand back first, and nothing new starts meanwhile. A second signal stops at once.
  let draining = false;
  const stopGently = () => {
    if (stopping) return;
    if (draining || !engine) {
      if (draining) console.log(`${new Date().toISOString()} Stopping now, as asked twice`);
      stop();
      return;
    }
    draining = true;
    const limit = Number(process.env.PETRINA_DRAIN_MS) || DRAIN_MS;
    void engine
      .drain(limit, (left) => {
        if (left) console.log(`${new Date().toISOString()} Petrina is stopping: waiting for ${left} agent${left === 1 ? "" : "s"} to hand back, up to ${Math.max(1, Math.round(limit / 60_000))} minute${limit >= 90_000 ? "s" : ""} (a second Ctrl-C stops now)`);
      })
      .then((left) => {
        if (left) console.log(`${new Date().toISOString()} ${left} agent${left === 1 ? "" : "s"} did not hand back in time: stopping anyway`);
        stop();
      });
  };
  process.on("SIGINT", stopGently);
  process.on("SIGTERM", stopGently);

  try {
    if (app && options.loginShell !== false) {
      const path = await loginShellPath();
      if (path) process.env.PATH = mergePath(path, process.env.PATH);
    }
    engine = new Engine(home, options.engine);
    const token = (!options.newKey && previousToken(home)) || randomBytes(24).toString("base64url");
    server = serve(engine, { port: app ? 0 : (options.port ?? 4317), token, ...(options.ui ? { ui: options.ui } : {}) });
    const connection: Connection = { url: `ws://127.0.0.1:${server.port}/ws`, api: `http://127.0.0.1:${server.port}`, token, pid: process.pid };
    // Scripts keep reading engine.json, whoever started the engine.
    writeConnection(home, connection);
    // Which tools are ready, in the background: first run and the squad read the answers as they come.
    void engine.checkTools();
    console.log(`Petrina engine on ${connection.api} (data in ${home})`);
    if (app) {
      tell({ type: "ready", owned: true, url: connection.url, token });
      process.stdin.on("end", () => stop());
      process.stdin.on("close", () => stop());
      process.stdin.on("error", () => stop());
      process.stdin.resume();
    }
  } catch (error) {
    console.error("Petrina's engine could not start:", error);
    if (app) tell({ type: "error", message: `Petrina's engine could not start: ${error instanceof Error ? error.message : String(error)}` });
    stop(1);
  }
}
