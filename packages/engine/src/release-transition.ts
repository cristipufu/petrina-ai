import { rmSync } from "node:fs";
import type { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { answers, FolderLock, processAlive, readConnection } from "./instance.js";
import { ReleaseStore, type ReleasePointer } from "./release-store.js";

export type LifecycleTransitionAction =
  | { readonly kind: "stop" }
  | { readonly kind: "restart" }
  | { readonly kind: "promote"; readonly version: string }
  | { readonly kind: "rollback" };

export interface ExecuteTransitionInput {
  readonly home: string;
  readonly mode: "serve" | "app";
  readonly action: Exclude<LifecycleTransitionAction, { readonly kind: "stop" }>;
  readonly reconnectPort: number;
  readonly lock: FolderLock;
  readonly lifecycleStore: LifecycleStore;
}

const DEFAULT_PROMOTE_READINESS_TIMEOUT_MS = 15_000;

function cliSubArgs(mode: "serve" | "app"): string[] {
  const fromArgv = process.argv.slice(2);
  return fromArgv.length > 0 ? fromArgv : [mode];
}

function cleanTransitionEnv(
  reconnectPort: number,
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PETRINA_LIFECYCLE_REPLACEMENT: "1",
    PETRINA_RECONNECT_PORT: String(reconnectPort),
    ...extra,
  };
  if (!("PETRINA_AUTO_ROLLBACK_MESSAGE" in extra)) delete env.PETRINA_AUTO_ROLLBACK_MESSAGE;
  if (!("PETRINA_AUTO_ROLLBACK_VERSION" in extra)) delete env.PETRINA_AUTO_ROLLBACK_VERSION;
  if (!("PETRINA_PROMOTE_SUPERVISED" in extra)) delete env.PETRINA_PROMOTE_SUPERVISED;
  return env;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !processAlive(pid);
}

async function takeLockBriefly(home: string, timeoutMs: number): Promise<FolderLock | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const claimed = FolderLock.take(home);
    if (claimed) return claimed;
    await Bun.sleep(25);
  }
  return FolderLock.take(home) ?? null;
}

export async function executeLifecycleTransition(input: ExecuteTransitionInput): Promise<void> {
  const { home, mode, action, reconnectPort, lock, lifecycleStore } = input;
  const releaseStore = new ReleaseStore(home);
  const subArgs = cliSubArgs(mode);
  const fallbackCommand = [process.execPath, ...process.argv.slice(1)];

  let targetPointer: ReleasePointer | null = null;
  let previousPointer: ReleasePointer | null = null;

  if (action.kind === "promote") {
    const promoted = releaseStore.promote(action.version);
    targetPointer = promoted.current;
    previousPointer = promoted.previous;
  } else if (action.kind === "rollback") {
    const restored = releaseStore.rollback();
    targetPointer = restored.current;
  } else {
    targetPointer = releaseStore.readCurrent();
  }

  const command = targetPointer ? releaseStore.commandFor(targetPointer, subArgs) : fallbackCommand;

  // Release folder ownership only after pointer updates and lifecycle state reservation are saved.
  lock.release();

  const child = Bun.spawn(command, {
    env: cleanTransitionEnv(
      reconnectPort,
      action.kind === "promote" ? { PETRINA_PROMOTE_SUPERVISED: "1" } : {},
    ),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    windowsHide: true,
  });

  if (action.kind !== "promote") {
    lifecycleStore.noteLauncher(child.pid);
    child.unref();
    return;
  }
  lifecycleStore.noteLauncher(process.pid);

  const configuredTimeout = Number(process.env.PETRINA_PROMOTE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout >= 200
      ? configuredTimeout
      : DEFAULT_PROMOTE_READINESS_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const op = lifecycleStore.current;
    const conn = readConnection(home);
    if (
      op?.phase === "completed"
      && conn
      && conn.pid === child.pid
      && (await answers(conn, 500))
    ) {
      child.unref();
      return;
    }
    if (child.exitCode !== null || !processAlive(child.pid) || op?.phase === "failed") {
      break;
    }
    await Bun.sleep(50);
  }

  // Candidate failed or timed out before passing /health readiness: confirm exit before rollback.
  if (processAlive(child.pid)) {
    try {
      child.kill();
    } catch {
      // Child may have exited concurrently.
    }
  }
  const exited = await waitForExit(child.pid, 2_000);
  if (!exited) {
    lifecycleStore.finish(
      "failed",
      `Engine release ${action.version} did not pass health checks, and its process exit could not be confirmed; automatic rollback was withheld to prevent a competing engine.`,
    );
    return;
  }

  const rollbackLock = await takeLockBriefly(home, 1_000);
  let restoredLabel = "previous engine";
  let rollbackCommand = fallbackCommand;
  try {
    if (previousPointer) {
      const restored = releaseStore.rollback();
      restoredLabel = restored.current.version;
      rollbackCommand = releaseStore.commandFor(restored.current, subArgs);
    } else {
      rmSync(releaseStore.currentPath, { force: true });
    }
    lifecycleStore.finish("starting", undefined, process.pid);
  } finally {
    rollbackLock?.release();
  }

  const rollbackMessage = previousPointer
    ? `Engine release ${action.version} failed startup before passing health checks. Petrina automatically rolled back to ${previousPointer.version}.`
    : `Engine release ${action.version} failed startup before passing health checks. Petrina cleared the release pointer and restored the previous engine.`;

  const rollbackChild = Bun.spawn(rollbackCommand, {
    env: cleanTransitionEnv(reconnectPort, {
      PETRINA_AUTO_ROLLBACK_MESSAGE: rollbackMessage,
      PETRINA_AUTO_ROLLBACK_VERSION: restoredLabel,
    }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    windowsHide: true,
  });
  lifecycleStore.noteLauncher(rollbackChild.pid);
  rollbackChild.unref();
}
