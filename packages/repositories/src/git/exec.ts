// Local Git process execution, environment sanitization and per-worktree serialization.
// Every command runs as an argument array without a shell, hooks or file monitors.
// Unauthenticated commands strip GitHub/askpass credentials via gitEnv().

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { withGitConfig, withoutCredentials } from "@petrina/platform/process-environment";
import { EXIT_GRACE_MS, lostExit } from "@petrina/platform/process-tree";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Requested binary stdout, retained before decoding byte-counted Git protocols. */
  stdoutBytes?: Uint8Array;
  /** The command did not finish as far as Petrina can tell: stopped at its time limit, or its exit was never reported. */
  timedOut?: boolean;
  /** The process was observed gone or defunct, but its exit was never reported; its result is unknown. */
  exitUnreported?: boolean;
  /** No program started. Exit numbers alone cannot distinguish this from a program's own answer. */
  startFailure?: StartFailure;
}

export interface StartFailure {
  kind: "missing-executable" | "temporary-directory" | "working-directory" | "permission" | "other";
  message: string;
  systemCode?: string;
}

export const EXIT_UNREPORTED = "Git finished, but the system did not report its exit";

export const OUTPUT_INCOMPLETE = "Git finished, but its output did not finish arriving";

export const OUTPUT_UNREADABLE = "Git's output could not be read";

/** The `gh` command to run. A host can provide an explicit scripted GitHub peer. */
export type Gh = readonly string[];

/**
 * Where Petrina fetches from and publishes to: the product's saved address. `local`: a test
 * stand-in for GitHub (a folder), explicitly provided by the host.
 */
export interface Remote {
  url: string;
  local?: boolean;
}

/** An answer from GitHub, or why there is none. "Not there" and "could not ask" never look alike. */
export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

const INITIAL_BUN_SPAWN = Bun.spawn;

export function isSpawnIntercepted(): boolean {
  return Bun.spawn !== INITIAL_BUN_SPAWN || "mock" in Bun.spawn || "mock" in run;
}

export let empty: string | undefined;

/** Empty folders for "no hooks", "no gh login" and "no grafts", made once per process. */
function emptyDir(name: "hooks" | "gh" | "grafts"): string {
  if (!empty) {
    // Test engines already have their own disposable home. Keep their helpers there too, so
    // the parent fixture removes them after a forced stop instead of filling the shared temp folder.
    const parent = process.env.PETRINA_HOME ? join(process.env.PETRINA_HOME, "runtime-tmp") : tmpdir();
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const owned = mkdtempSync(join(parent, "petrina-none-"));
    empty = owned;
    process.once("exit", () => {
      try { rmSync(owned, { recursive: true, force: true }); } catch { /* The system can reclaim an inaccessible empty folder. */ }
    });
  }
  const dir = join(empty, name);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Settings that can make a credentialed fetch or push run a program: only normal https and ssh remotes. */
const SAFE_TRANSPORT: readonly (readonly [string, string])[] = [
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
  ["protocol.ssh.allow", "always"],
  ["protocol.ext.allow", "never"],
  ["protocol.file.allow", "never"],
  ["protocol.git.allow", "never"],
  ["remote.origin.uploadpack", "git-upload-pack"],
  ["fetch.recurseSubmodules", "false"],
  // A connection slower than 1 KB/s for 20 seconds gives up, so nothing lingers after a time limit.
  ["http.lowSpeedLimit", "1000"],
  ["http.lowSpeedTime", "20"],
];

function gitEnv(credentials: boolean, options: { local?: boolean; ownHooks?: boolean } = {}): NodeJS.ProcessEnv {
  const base = credentials ? process.env : withoutCredentials(process.env, emptyDir("gh"));
  const transport = credentials ? [...SAFE_TRANSPORT, ...(options.local ? ([["protocol.file.allow", "always"]] as const) : [])] : [];
  // `ownHooks` only for finding the repository's own hooks: never with credentials, never running a git step.
  const hooks = options.ownHooks && !credentials ? [] : [["core.hooksPath", emptyDir("hooks")] as const];
  const settings = [
    ...hooks,
    ["core.fsmonitor", "false"] as const,
    ["gc.auto", "0"] as const,
    ["maintenance.auto", "false"] as const,
    ...transport,
  ];
  // Replace objects could make a commit Petrina pinned show different content, and a grafts file (info/grafts,
  // read in place of one that never exists) different parents, hiding commits from history Petrina checks.
  return {
    ...withGitConfig(
    base,
    settings
  ),
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: join(
    emptyDir("grafts"),
    "none"
  ),
    ...(credentials ? { GH_PROMPT_DISABLED: "1" } : {})
  };
}

/** The hooks git runs when it commits, in the order it runs them. */
export const COMMIT_HOOKS = ["pre-commit", "commit-msg"] as const;

export type CommitHook = (typeof COMMIT_HOOKS)[number];

/** How long Petrina waits for GitHub before giving up on a lookup or a fetch. */
export const FETCH_TIMEOUT_MS = 30_000;

export function systemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Only an absent file is evidence of a missing program; unreadable files are not. */
function absent(path: string): boolean {
  try {
    statSync(path);
    return false;
  }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes(systemCode(error) ?? ""); }
}

function launchFailure(error: unknown, command: string | undefined, cwd: string): StartFailure["kind"] {
  const code = systemCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOENT" || code === "ENOTDIR") {
    const message = error instanceof Error ? error.message : String(error);
    const file = command && (command.includes("/") || (process.platform === "win32" && command.includes("\\")));
    if ((file && absent(resolve(
      cwd,
      command
    ))) || (!file && code === "ENOENT" && message.startsWith("Executable not found in $PATH:"))) return "missing-executable";
    try { if (!statSync(cwd).isDirectory()) return "working-directory"; }
    catch (cause) { if (["ENOENT", "ENOTDIR"].includes(systemCode(cause) ?? "")) return "working-directory"; }
  }
  return "other";
}

function neverStarted(error: unknown, kind: StartFailure["kind"]): RunResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = systemCode(error);
  // Preserve the legacy number and message for callers that handle all command failures alike.
  return { code: 127, stdout: "", stderr: message, startFailure: { kind, message, ...(code ? { systemCode: code } : {}) } };
}

/** Private native launch boundary for command-lifecycle contracts, retaining real process handles and pipes. */
export type RunStart = (command: readonly string[], options: {
  cwd: string;
  stdin: "ignore" | Blob;
  stdout: "pipe";
  stderr: "pipe";
  env: NodeJS.ProcessEnv;
  windowsHide: true;
}) => ReturnType<typeof Bun.spawn>;

export async function run(cmd: readonly string[], cwd: string, input?: string, options: {
  credentials?: boolean;
  local?: boolean;
  timeoutMs?: number;
  ownHooks?: boolean;
  index?: string;
  rawOutput?: boolean;
  binaryOutput?: boolean;
  start?: RunStart
} = {}): Promise<RunResult> {
  let env: NodeJS.ProcessEnv;
  try {
    env = {
      ...gitEnv(
      options.credentials === true,
      {
      local: options.local === true,
      ownHooks: options.ownHooks === true
    }
    ),
      ...(options.index ? { GIT_INDEX_FILE: options.index } : {})
    };
  } catch (error) {
    return neverStarted(error, "temporary-directory");
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const settings = {
      cwd,
      stdin: input === undefined ? "ignore" as const : new Blob([input]),
      stdout: "pipe" as const,
      stderr: "pipe" as const,
      env,
      windowsHide: true as const,
    };
    proc = options.start ? options.start([...cmd], settings) : Bun.spawn([...cmd], settings);
  } catch (error) {
    return neverStarted(error, launchFailure(error, cmd[0], cwd));
  }
  // Read while the process writes: a saved file can exceed the pipe's capacity before Git exits.
  const readers = [proc.stdout, proc.stderr].map(stream => (stream as ReadableStream<Uint8Array>).getReader());
  const captured = ["", ""];
  const bytes: Uint8Array[] = [];
  const output = Promise.all(readers.map(async (reader, index) => {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: options.rawOutput === true && index === 0 });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (options.binaryOutput && index === 0) bytes.push(next.value);
        else captured[index] += decoder.decode(next.value, { stream: true });
      }
      captured[index] += decoder.decode();
    } finally { reader.releaseLock(); }
  }));
  // The deadline covers both exit and output. An exited parent's helper can retain a pipe; a
  // lost runtime notification can leave BOTH its exit and its output pending. Watch process state
  // independently of pipe completion, and never infer success from closed pipes or a dead process.
  const watch = new AbortController();
  const lost = typeof proc.pid === "number" ? lostExit(proc.pid, watch.signal) : new Promise<never>(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const deadline = options.timeoutMs ? new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), options.timeoutMs))) : undefined;
  const complete = Promise.all([proc.exited, output]).then(([code]) => ({ code }), error => ({ error }));
  const drainDeadline = proc.exited.then(() => new Promise<"output-incomplete">((resolve) => {
    if (!settled) drainTimer = setTimeout(() => resolve("output-incomplete"), EXIT_GRACE_MS);
  }), () => new Promise<never>(() => {}));
  const first = await Promise.race([complete, lost, drainDeadline, ...(deadline ? [deadline] : [])]);
  settled = true;
  watch.abort();
  clearTimeout(timer);
  clearTimeout(drainTimer);
  const out = () => options.rawOutput ? captured[0]! : captured[0]!.trim();
  if (typeof first !== "object" || "error" in first) {
    // A process already observed ended needs no signal; a collected PID can belong to somebody else.
    if (first !== "lost" && first !== "output-incomplete" && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* Already gone. */ }
    }
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    const reason = first === "lost" ? EXIT_UNREPORTED : first === "output-incomplete" ? OUTPUT_INCOMPLETE : typeof first === "object" ? `${OUTPUT_UNREADABLE}: ${String(first.error)}` : "timed out";
    return {
      code: 124,
      stdout: out(),
      stderr: [
      captured[1]!.trim(),
      reason
    ].filter(Boolean).join("\n"),
      timedOut: true,
      ...(first === "lost" ? { exitUnreported: true } : {})
    };
  }
  return { code: first.code, stdout: out(), stderr: captured[1]!.trim(), ...(options.binaryOutput ? { stdoutBytes: Buffer.concat(bytes) } : {}) };
}

export async function must(cmd: readonly string[], cwd: string, input?: string): Promise<string> {
  const result = await run(cmd, cwd, input);
  if (result.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export const commandFailure = (result: RunResult): {
  ok: false;
  error: string
} => ({
  ok: false,
  error: (result.stderr || result.stdout || `exit ${result.code}`).slice(
  0,
  300
)
});

/**
 * Git trips over a worktree another one is still creating ("failed to read .git/worktrees/…/commondir"),
 * so tasks starting together add and remove one repository's worktrees one at a time.
 */
const worktreeTurns = new Map<string, Promise<void>>();

export function oneAtATime<T>(root: string, work: () => Promise<T>): Promise<T> {
  const turn = (worktreeTurns.get(root) ?? Promise.resolve()).then(work);
  worktreeTurns.set(
    root,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
}

/** A reason a working copy could not be removed, in plain words for the timeline. */
export class Reason extends Error {}

/** How long Petrina waits for git while removing a working copy. */
export const CLEANUP_GIT_TIMEOUT_MS = 60_000;

/** A path with its links resolved, also when its last parts no longer exist. */
export function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    // Native resolution also expands Windows short names, which Git reports in their full form.
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/** Resolve aliases in a folder's parent, but never follow the working-copy folder itself if it became a link. */
export function worktreeLocation(path: string): string {
  const absolute = resolve(path);
  return join(canonical(dirname(absolute)), basename(absolute));
}
