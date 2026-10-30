import { failAbandonedLifecycle } from "./lifecycle-ownership.js";
// Starting and stopping an engine process.
// - `serve`: started by hand in a terminal, on the usual port. Refuses if one is already running.
// - `app`: started by the desktop shell. Steps aside for an engine that is already running, picks
//   a free port, and talks to the shell only over its stdin and stdout: one line on stdout to say
//   it is ready (with its address and key, which never go to a log), and stdin closing means the
//   app is gone, quit or crashed, so the engine stops.

import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Engine, type EngineOptions } from "./engine.js";
import { loginShellPath } from "@petrina/platform/login-shell";
import { mergePath } from "@petrina/platform/environment-values";
import { answers, claimFolder, type Connection, FolderLock, previousToken, readConnection, removeConnection, writeConnection } from "./instance.js";
import { OutputLog } from "./log.js";
import { serve } from "./server.js";
import { EngineLifecycle } from "./lifecycle.js";
import { executeLifecycleTransition } from "./release-transition.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";

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

const ALREADY_RUNNING = "Petrina's engine is already running. Open it with bun run open.";
const BUSY = "Another Petrina engine holds this folder but does not answer. Wait a moment and try again; if it stays like this, stop the other engine";

function tell(message: ShellMessage): void {
  // Written straight to the pipe: the shell reads it, nothing logs it.
  writeSync(1, `${JSON.stringify(message)}\n`);
}

/** Let the desktop shell distinguish an accepted lifecycle drain from a lost engine. */
function signalDesktopHandoff(active: boolean): void {
  try { writeSync(1, `${JSON.stringify({ type: "handoff", active })}\n`); } catch { /* The app may have closed already. */ }
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
  const lifecycleStore = new LifecycleStore(home);
  const prior = lifecycleStore.current;
  const recovery = app && !process.env.PETRINA_LIFECYCLE_REPLACEMENT;
  const unfinishedHandoff = (op: typeof prior) => op && ([
    "stop",
    "restart",
    "promote",
    "rollback",
  ].includes(op.kind) || op.phase === "starting") && ![
    "completed",
    "failed"
  ].includes(op.phase);
  const followHandoff = async () => {
    // The shell's old child may have exited before its requested replacement starts. This
    // recovery process follows a live replacement. Only confirmed loss of ownership and its
    // process lets recovery fail the handoff and claim the folder for one new engine.
    log.discard();
    const deadline = Date.now() + 25_000;
    for (;;) {
      const operation = lifecycleStore.current;
      if (operation?.phase === "failed") return;
      if (operation?.kind === "stop" && operation.phase === "completed") {
        tell({ type: "error", message: "The engine was intentionally stopped. Use petrina engine start to start it again." });
        break;
      }
      const connection = readConnection(home);
      if (operation?.phase === "completed" && connection && await answers(connection, 500)) {
        tell({ type: "running", owned: false, url: connection.url, token: connection.token });
        break;
      }
      const ownership = FolderLock.take(home);
      try {
        if (ownership && failAbandonedLifecycle(lifecycleStore, home, ownership)) return;
      } finally { ownership?.release(); }
      if (Date.now() >= deadline) {
        tell({ type: "error", message: "The engine handoff is still in progress. Reconnect to follow it; no additional engine was started." });
        break;
      }
      await Bun.sleep(100);
    }
    lifecycleStore.close();
    process.exit(0);
  };
  if (recovery && unfinishedHandoff(prior) && prior?.phase !== "draining") await followHandoff();
  // Desktop reconnect/recovery is not permission to undo an intentional stop.
  if (app && prior?.kind === "stop" && prior.phase === "completed") {
    log.discard();
    tell({ type: "error", message: "The engine was intentionally stopped. Use petrina engine start to start it again." });
    lifecycleStore.close();
    process.exit(0);
  }
  let claim = await claimFolder(home);
  while (claim.kind === "free" && recovery && unfinishedHandoff(lifecycleStore.current)) {
    if (failAbandonedLifecycle(lifecycleStore, home, claim.lock)) break;
    claim.lock.release();
    await followHandoff();
    claim = await claimFolder(home);
  }
  if (claim.kind !== "free") {
    // Stepping aside: the log belongs to the engine that holds the folder.
    log.discard();
    if (app) tell(claim.kind === "running" ? {
      type: "running",
      owned: false,
      url: claim.connection.url,
      token: claim.connection.token
    } : {
      type: "error",
      message: `${BUSY}.`
    });
    else process.stderr.write(claim.kind === "running" ? `${ALREADY_RUNNING}\n` : `${BUSY}.\n`);
    process.exit(app && claim.kind === "running" ? 0 : 1);
  }

  const { lock } = claim;
  const latest = lifecycleStore.current;
  const recoverFailedHandoff = recovery && latest?.phase === "failed" && ["pause", "stop", "restart", "promote", "rollback"].includes(latest.kind);
  if (app && latest && ((latest.kind === "stop" && ["stopping", "completed"].includes(latest.phase)) || (latest.phase === "failed" && !recoverFailedHandoff))) {
    // Recheck after taking ownership: the app may have opened while the old owner was handing
    // the folder back. Recovery must not turn that intentional stop into a fresh launch.
    lock.release();
    log.discard();
    tell({ type: "error", message: latest.error ?? "The engine was intentionally stopped. Use petrina engine start to start it again." });
    lifecycleStore.close();
    process.exit(0);
  }
  if (recoverFailedHandoff || (!app && latest && (["completed", "failed"].includes(latest.phase)))) {
    // Recovery and explicit legacy `serve` keep the failed/finished receipt. Reserve the new
    // start while holding ownership so every reconnect discovers the same engine.
    lifecycleStore.begin(
      "start",
      { requestId: `${app ? "recovery" : "serve"}-${randomBytes(12).toString("hex")}` },
      latest!.scheduling,
      undefined,
      process.pid
    );
  }
  // Taking ownership also transfers an offline caller's reservation to this engine.
  if (!process.env.PETRINA_PROMOTE_SUPERVISED) lifecycleStore.noteLauncher(process.pid);
  log.open(join(home, "engine.log"));
  console.log(`${new Date().toISOString()} Petrina engine starting (process ${process.pid}, ${app ? "started by the app" : "started by hand"}, data in ${home})`);

  let engine: Engine | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let stopping = false;
  let lifecycle: EngineLifecycle | undefined;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    // Never hang on the way out: the shell stops waiting after a few seconds anyway.
    setTimeout(() => process.exit(code), 7000).unref();
    try {
      server?.stop(true);
      lifecycle?.close();
      await engine?.shutdown();
    } catch (error) {
      console.error("While stopping:", error);
    }
    // An app engine takes its connection file with it. One started by hand leaves it, so the next
    // start keeps the key and open browser windows reconnect; a stale file is never trusted alone.
    if (app && !process.env.PETRINA_LIFECYCLE_REPLACEMENT) removeConnection(home, process.pid);
    lock.release();
    console.log(`${new Date().toISOString()} Petrina engine stopped`);
    log.close();
    process.exit(code);
  };
  process.on("uncaughtException", (error) => {
    console.error("Petrina's engine crashed:", error);
    stop(1);
  });
  // A manual stop drains admitted work without a deadline; nothing new starts meanwhile.
  // A second signal explicitly interrupts instead of waiting for that work to finish.
  let draining = false;
  const stopGently = () => {
    if (stopping) return;
    if (draining || !engine) {
      if (draining) console.log(`${new Date().toISOString()} Stopping now, as asked twice`);
      stop();
      return;
    }
    draining = true;
    engine.drainReason = "stop";
    const limit = Infinity;
    void engine
      .drain(limit, (left) => {
        if (left) console.log(`Petrina is stopping: ${left} active work item${left === 1 ? "" : "s"} still finishing (a second Ctrl-C interrupts).`);
      })
      .then((left) => {
        if (left) return;
        return stop();
      }).catch(error => {
        console.error("Petrina could not confirm cleanup while stopping:", error);
        // The existing shutdown still joins every owner. A known cleanup failure is
        // a nonzero terminal result, never permission to force or remove its files.
        void stop(1).catch(error => console.error("While stopping:", error));
      });
  };
  process.on("SIGINT", stopGently);
  process.on("SIGTERM", stopGently);

  try {
    if (app && options.loginShell !== false) {
      const path = await loginShellPath();
      if (path) process.env.PATH = mergePath(path, process.env.PATH, delimiter);
    }
    engine = new Engine(home, { ...options.engine, admissionsClosed: true });
    await engine.waitUntilReady();
    await engine.startupSweep;
    lifecycle = new EngineLifecycle(engine, lifecycleStore, async (restart, action) => {
      const reconnectPort = server?.port ?? 0;
      lifecycle?.close();
      server?.stop(true);
      await engine!.shutdown();
      // Reserve the replacement before releasing ownership. Desktop recovery follows this
      // operation during the gap, including when its former child has already exited.
      if (restart) lifecycleStore.finish("starting", undefined, process.pid);
      if (restart) {
        const transition =
          action && action.kind !== "stop" ? action : ({ kind: "restart" } as const);
        await executeLifecycleTransition({
          home,
          mode,
          action: transition,
          reconnectPort,
          lock,
          lifecycleStore,
        });
      } else {
        // The old owner is fully settled before releasing folder ownership.
        lock.release();
        lifecycleStore.finish("completed");
      }
      log.close();
      process.exit(0);
    }, app ? signalDesktopHandoff : undefined);
    const token = ((!options.newKey || process.env.PETRINA_LIFECYCLE_REPLACEMENT) && previousToken(home)) || randomBytes(24).toString("base64url");
    server = serve(
      engine,
      {
      port: Number(process.env.PETRINA_RECONNECT_PORT) || (app ? 0 : (options.port ?? 4317)),
      token,
      lifecycle,
      ...(options.ui ? { ui: options.ui } : {})
    }
    );
    const connection: Connection = { url: `ws://127.0.0.1:${server.port}/ws`, api: `http://127.0.0.1:${server.port}`, token, pid: process.pid };
    // Scripts keep reading engine.json, whoever started the engine.
    writeConnection(home, connection);
    lifecycle.ready();
    // Which tools are ready, in the background: first run and the squad read the answers as they come.
    void engine.checkTools();
    console.log(`Petrina engine on ${connection.api} (data in ${home})`);
    if (app) {
      tell({ type: "ready", owned: true, url: connection.url, token });
      if (!process.env.PETRINA_LIFECYCLE_REPLACEMENT) {
        const closed = () => {
          const operation = lifecycleStore.current;
          const handoff = operation && [
            "stop",
            "restart",
            "promote",
            "rollback"
          ].includes(operation.kind) && ![
            "completed",
            "failed"
          ].includes(operation.phase);
          if (!handoff) void stop();
        };
        process.stdin.on("end", closed);
        process.stdin.on("close", closed);
        process.stdin.on("error", closed);
        process.stdin.resume();
      }
    }
  } catch (error) {
    if (!process.env.PETRINA_PROMOTE_SUPERVISED) {
      lifecycleStore.finish(
        "failed",
        "The replacement engine could not start. Saved work remains available; inspect the engine log and explicitly start again."
      );
    }
    console.error("Petrina's engine could not start:", error);
    if (app) tell({ type: "error", message: `Petrina's engine could not start: ${error instanceof Error ? error.message : String(error)}` });
    stop(1);
  }
}
