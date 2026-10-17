// A product's checks: the commands that prove it works (type check, lint, tests, build). Petrina
// runs them itself, so "the tests pass" is evidence, never an agent's word. Commands are argument
// arrays, never a shell, and they run in the task's working copy without credentials.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun, ProductCheck } from "@petrina/core";

/** Long enough for a full test suite or build, short enough that a hung one never holds a task. */
export const CHECK_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_KEPT = 6000;

/** The scripts that usually prove a JavaScript project works, in the order they are worth running. */
const SCRIPTS: readonly [string, string][] = [
  ["typecheck", "Type check"],
  ["check-types", "Type check"],
  ["lint", "Lint"],
  ["test", "Tests"],
  ["build", "Build"],
];

function packageManager(root: string): string {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Suggest checks from what the repository already declares. The coordinator can change them. */
export function detectChecks(root: string): ProductCheck[] {
  const checks: ProductCheck[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const pm = packageManager(root);
      const seen = new Set<string>();
      for (const [script, name] of SCRIPTS) {
        if (typeof scripts[script] !== "string" || seen.has(name)) continue;
        // npm's placeholder test script fails on purpose: it proves nothing.
        if (script === "test" && /no test specified/i.test(String(scripts[script]))) continue;
        seen.add(name);
        checks.push({ name, argv: [pm, "run", script] });
      }
    } catch {
      // An unreadable package.json suggests nothing.
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) checks.push({ name: "Rust tests", argv: ["cargo", "test"] });
  if (existsSync(join(root, "go.mod"))) checks.push({ name: "Go vet", argv: ["go", "vet", "./..."] }, { name: "Go tests", argv: ["go", "test", "./..."] });
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) checks.push({ name: "Python tests", argv: ["python3", "-m", "pytest", "-q"] });
  return checks;
}

/** Plain text for the window: no colour codes, only the end of long output. */
export function tidyOutput(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal colour codes
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
  return plain.length > OUTPUT_KEPT ? `…\n${plain.slice(-OUTPUT_KEPT)}` : plain;
}

export function commandText(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

/** Split a command the coordinator typed into arguments, honouring quotes. Never run through a shell. */
export function parseCommand(text: string): string[] {
  const argv: string[] = [];
  let word = "";
  let quote: string | undefined;
  let inWord = false;
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) argv.push(word);
  return argv;
}

/**
 * Run the checks side by side, so the wait is the slowest check rather than the sum of them, and
 * report what really happened, in the order given. Stopping the task stops every check.
 */
export async function runChecks(cwd: string, checks: readonly ProductCheck[], env: NodeJS.ProcessEnv, timeoutMs = CHECK_TIMEOUT_MS, signal?: AbortSignal): Promise<CheckRun[]> {
  if (signal?.aborted) return [];
  const runs = checks
    .filter((check) => check.argv.length)
    .map(async (check): Promise<CheckRun> => {
      const started = Date.now();
      const run = await runOne(check.argv, cwd, env, timeoutMs, signal);
      const result = { name: check.name, command: commandText(check.argv), ms: Date.now() - started };
      if (run.error) return { ...result, ok: false, output: `Could not start: ${run.error}` };
      if (run.timedOut) return { ...result, ok: false, timedOut: true, output: tidyOutput(`${run.output}\nStopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing.`) };
      return { ...result, ok: run.code === 0, output: tidyOutput(run.output) };
    });
  return Promise.all(runs);
}

/**
 * One command, with only the end of its output kept while it runs, so a noisy check never fills
 * memory. It gets a process group of its own: a timeout or a stopped task ends everything it started.
 */
function runOne(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    let kept = "";
    let cut = false;
    let timedOut = false;
    let done = false;
    let child: ChildProcess | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", stop);
      resolve({ code, output: `${cut ? "…\n" : ""}${kept}`, timedOut, ...(error ? { error } : {}) });
    };
    const stop = () => stopAll(child?.pid, windows);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const keep = (chunk: Buffer) => {
      kept += chunk.toString("utf8");
      if (kept.length > OUTPUT_KEPT * 2) {
        kept = kept.slice(-OUTPUT_KEPT * 2);
        cut = true;
      }
    };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    child.once("error", (error) => finish(null, error.message));
    // Output can stay open in something the check left running in the background: don't wait on it for long.
    child.once("exit", (code) => (grace = setTimeout(() => finish(code), 5000)));
    child.once("close", (code) => finish(code));
  });
}

/** End a check and everything it started. */
function stopAll(pid: number | undefined, windows: boolean): void {
  if (!pid) return;
  try {
    if (windows) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Whether two sets of checks run the same commands (names and reasons aside). */
export function sameCommands(a: readonly ProductCheck[], b: readonly ProductCheck[]): boolean {
  return a.length === b.length && a.every((check, index) => commandText(check.argv) === commandText(b[index]!.argv));
}

/** The files a product's checks come from: CI workflows and build files at the root. */
const CI_FOLDERS = [".github/workflows", ".gitlab", ".circleci", ".azure-pipelines"];
const BUILD_FILE = /^(package\.json|bun\.lockb?|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|Package\.swift|Makefile|Justfile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|global\.json|Directory\.Build\.props|.+\.sln|.+\.csproj|.+\.fsproj|azure-pipelines\.ya?ml|\.gitlab-ci\.ya?ml|turbo\.json|nx\.json)$/;

/** A fingerprint of what the Check finder bases its answer on. It changes when CI or build files do. */
export function checksFingerprint(root: string): string {
  const hash = createHash("sha256");
  const add = (path: string, name: string) => {
    try {
      if (statSync(path).isFile()) hash.update(`${name}\0`).update(readFileSync(path)).update("\0");
    } catch {
      // Gone or unreadable: it simply doesn't count.
    }
  };
  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return "";
  }
  for (const name of entries) if (BUILD_FILE.test(name)) add(join(root, name), name);
  for (const folder of CI_FOLDERS) {
    try {
      for (const name of readdirSync(join(root, folder)).sort()) add(join(root, folder, name), `${folder}/${name}`);
    } catch {
      // No such folder.
    }
  }
  return hash.digest("hex").slice(0, 16);
}
