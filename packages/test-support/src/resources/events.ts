// Opt-in diagnostic only. This module is preloaded in private test processes, never in the app.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resourceUsageRecord } from "./usage.js";
import { fileURLToPath } from "node:url";
import { gitCaller } from "./git-callers.js";

export interface ResourceCase { id: string; file: string; name: string }
export const context = new AsyncLocalStorage<ResourceCase>();
const output = process.env.PETRINA_TEST_RESOURCE_DIR;
const traceGit = process.env.PETRINA_TEST_RESOURCE_GIT_CALLERS === "1";
const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const instance = crypto.randomUUID();
const file = output ? join(output, `events-${process.pid}-${instance}.jsonl`) : undefined;
let queue: string[] = [], bytes = 0, queuedBytes = 0, failed = false, ending = false, sequence = 0, starting = false;
if (output) mkdirSync(output, { recursive: true });

function flush(): void {
  if (!file || !queue.length || failed) return;
  try { const body = queue.join(""); queue = []; queuedBytes = 0; appendFileSync(file, body); bytes += Buffer.byteLength(body); }
  catch { failed = true; process.stderr.write("[petrina-resource-observer-error] Could not write events; resource evidence is incomplete.\n"); }
}
export function event(value: Record<string, unknown>): void {
  if (!file || failed) return;
  const encoded = JSON.stringify({ pid: process.pid, instance, at: Date.now(), ...value }) + "\n";
  const size = Buffer.byteLength(encoded);
  if (size > 64 * 1024 || bytes + queuedBytes + size > 16 * 1024 * 1024) { queue.push(JSON.stringify({ kind: "truncated", pid: process.pid, instance, at: Date.now() }) + "\n"); flush(); failed = true; return; }
  queue.push(encoded); queuedBytes += size;
  if (queue.length >= 128 || ending) flush();
}
const timer = output ? setInterval(flush, 250) : undefined;
timer?.unref();
export function finishFile(): void { ending = true; clearInterval(timer); event({ kind: "file-end", file: Bun.main }); flush(); }
process.once("exit", () => { event({ kind: "process-end", cpu: process.cpuUsage(), memory: process.memoryUsage() }); flush(); });
event({ kind: "process-start", ppid: process.ppid }); flush();

const gitOperations = new Set(["add", "init", "clone", "config", "rev-parse", "status", "diff", "show", "log", "worktree", "checkout", "rev-list", "merge-base", "update-ref", "read-tree", "write-tree", "commit", "commit-tree", "cat-file", "ls-tree", "symbolic-ref", "branch", "merge", "reset", "fetch", "push", "update-index", "patch-id", "for-each-ref", "ls-files", "ls-remote", "notes"]);
const gitOptionValues = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);
function gitOperation(argv: unknown[]): string | undefined {
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index];
    if (typeof value !== "string") return;
    if (gitOptionValues.has(value)) { index++; continue; }
    if (value.startsWith("-")) continue;
    return gitOperations.has(value) ? value : undefined;
  }
}
function commandOf(command: unknown): { program: string; operation?: string } {
  const argv = Array.isArray(command) ? command : [command];
  const program = typeof argv[0] === "string" ? basename(argv[0]).replace(/\.exe$/i, "") : "unknown";
  return { program, ...(program === "git" ? { operation: gitOperation(argv) } : {}) };
}
function begin(command: unknown, api: string) {
  const named = commandOf(command);
  const caller = traceGit && named.program === "git" ? gitCaller(new Error().stack, sourceRoot) : undefined;
  return { id: `${process.pid}-${instance}-${++sequence}`, ...named, ...(caller ? { caller } : {}), api, case: context.getStore(), began: performance.now() };
}
function launched(info: ReturnType<typeof begin>, child?: number): void {
  const { began: _began, ...value } = info;
  event({ kind: "spawn", ...value, ...(child ? { child } : {}) });
}
function ended(info: ReturnType<typeof begin>, code: unknown, usage?: unknown): void {
  const { began, ...value } = info;
  event({ kind: "exit", ...value, code, wallMs: performance.now() - began, ...(usage ? { usage } : {}) });
}

if (output) {
  const native = Bun.spawn;
  Bun.spawn = ((...args: unknown[]) => {
    if (starting) return Reflect.apply(native, Bun, args);
    const command = Array.isArray(args[0]) ? args[0] : (args[0] as { cmd?: string[] })?.cmd;
    const info = begin(command, "Bun.spawn");
    let child: ReturnType<typeof Bun.spawn>;
    try { child = Reflect.apply(native, Bun, args) as ReturnType<typeof Bun.spawn>; }
    catch (error) { event({ kind: "spawn-error", id: info.id, case: info.case, api: info.api, program: info.program }); throw error; }
    launched(info, child.pid);
    void child.exited.then(code => {
      let usage: unknown;
      try { usage = resourceUsageRecord(child.resourceUsage()); } catch { /* Unavailable stays absent. */ }
      ended(info, code, usage);
    }, () => ended(info, null));
    return child;
  }) as typeof Bun.spawn;
  const nativeSync = Bun.spawnSync;
  Bun.spawnSync = ((...args: unknown[]) => {
    if (starting) return Reflect.apply(nativeSync, Bun, args);
    const command = Array.isArray(args[0]) ? args[0] : (args[0] as { cmd?: string[] })?.cmd;
    const info = begin(command, "Bun.spawnSync");
    try {
      const result = Reflect.apply(nativeSync, Bun, args) as ReturnType<typeof Bun.spawnSync>;
      launched(info, result.pid); ended(info, result.exitCode);
      return result;
    } catch (error) { event({ kind: "spawn-error", id: info.id, case: info.case, api: info.api, program: info.program }); throw error; }
  }) as typeof Bun.spawnSync;

  // Some adapters use node:child_process. Suppress nested implementation calls so one launch has one event.
  const target = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["spawn", "execFile", "exec", "fork", "spawnSync", "execFileSync", "execSync"]) {
    const native = target[name]!;
    target[name] = (...args: unknown[]) => {
      if (starting) return Reflect.apply(native, childProcess, args);
      const command = name === "exec" || name === "execSync" ? ["shell"] : [args[0], ...(Array.isArray(args[1]) ? args[1] : [])];
      const info = begin(command, `node.${name}`);
      starting = true;
      try {
        const result = Reflect.apply(native, childProcess, args);
        const child = result as { pid?: number; status?: number; once?: (event: string, callback: (...values: unknown[]) => void) => void } | undefined;
        if (name === "spawnSync" && (result as { error?: unknown })?.error) event({ kind: "spawn-error", id: info.id, case: info.case, api: info.api, program: info.program });
        else launched(info, child?.pid);
        if (name.endsWith("Sync")) {
          if (name !== "spawnSync" || !(result as { error?: unknown })?.error) ended(info, name === "spawnSync" ? child?.status ?? null : 0);
        }
        else { let finished = false; const end = (code: unknown) => { if (!finished) { finished = true; ended(info, code); } }; child?.once?.("exit", end); child?.once?.("error", () => end(null)); }
        return result;
      } catch (error) {
        const evidence = error as { pid?: number; status?: number } | null;
        if (typeof evidence?.pid === "number" && evidence.pid > 0) { launched(info, evidence.pid); ended(info, evidence.status ?? null); }
        else event({ kind: "spawn-error", id: info.id, case: info.case, api: info.api, program: info.program });
        throw error;
      } finally { starting = false; }
    };
  }
  syncBuiltinESMExports();
}
