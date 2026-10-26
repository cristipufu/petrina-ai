import { mock, spyOn } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { childState } from "@petrina/platform/process-tree";
import { processHost } from "@petrina/platform/process-host";
import type { MachineRecords } from "@petrina/platform/power-log";
import { runChecks } from "./check-runner.js";

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
const arm = (expired: () => void, ms: number) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };
const dispose = (dir: string) => {
  removeDir(dir);
  try { lstatSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`The check fixture could not remove ${dir}`);
};

export function checkOwner(dir: string, stop: () => void | Promise<void>) {
  let closing = false;
  const operations = new FixtureOperations({
    arm, allowanceMs: CLEANUP_MS * SLOW, label: `Check fixture at ${dir}`,
    stop: () => { closing = true; return stop(); }, dispose: () => dispose(dir),
  });
  return {
    run: <T>(start: () => Promise<T>) => operations.run(start),
    close: () => operations.close(),
    beforeStart: () => !closing,
  };
}

/** Observe the actual runner launch while forwarding every argument and every unrelated native call. */
export function checkStartCapture(dir: string, command: readonly string[]) {
  let child: Child | undefined, restore = () => {};
  const nativeSpawn = Bun.spawn.bind(Bun);
  return {
    child: () => child,
    restore: () => restore(),
    install() {
      const dispatch = ((...args: unknown[]) => {
        const first = args[0];
        const argv = Array.isArray(first) ? first : first && typeof first === "object" && "cmd" in first ? first.cmd : undefined;
        const options = Array.isArray(first) ? args[1] : first;
        const matches = Array.isArray(argv) && argv.length === command.length && argv.every((value, index) => value === command[index]) &&
          options && typeof options === "object" && "cwd" in options && options.cwd === dir;
        const started = Reflect.apply(nativeSpawn, undefined, args);
        if (matches) {
          const owned = started as Child;
          child = owned; void owned.exited.catch(() => undefined);
        }
        return started;
      }) as typeof Bun.spawn;
      const spawning = spyOn(Bun, "spawn");
      restore = () => spawning.mockRestore();
      spawning.mockImplementation(dispatch);
    },
  };
}

interface CheckExecutionOptions {
  timeoutMs?: number;
  name?: string;
  pendingName?: string;
}

/** Real leased children and native streams, with only the read/acquisition fault substituted. */
export async function checkExecutionFixture(mode: "plain" | "running" | "read-error" | "cancel-error" | "errored-output" | "locked-output" | "held-output" | "cancelled-before-return", options: CheckExecutionOptions = {}) {
  const root = tempDir("petrina-check-execution-"), ready = join(root, "ready.json"), script = join(root, "check.ts");
  const controller = new AbortController();
  let lease: ProcessLease | undefined, child: Child | undefined, locked: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let restore = () => {}, handed = false, used = false;
  let cancelledReaderClosed = false;
  const owner = checkOwner(root, async () => {
    const errors: unknown[] = [];
    try { restore(); } catch (error) { errors.push(error); }
    controller.abort();
    try { await lease?.close(); } catch (error) { errors.push(error); }
    if (child) try {
      if (await stopOwnedProcess(child, { graceMs: CLEANUP_MS * SLOW, forceMs: CLEANUP_MS * SLOW }, arm) !== "confirmed") throw new Error("The check fixture's native child did not stop");
    } catch (error) { errors.push(error); }
    try { await locked?.cancel(); } catch (error) { errors.push(error); }
    try { locked?.releaseLock(); } catch (error) { errors.push(error); }
    // Before handoff, these real descriptors remain the fixture's own responsibility.
    if (child && !handed) for (const stream of [child.stdout, child.stderr]) try { await stream.cancel(); } catch (error) { errors.push(error); }
    if (child) try {
      await waitFor(async () => await childState(child!.pid) === "ended", "the independently owned check process to end", CLEANUP_MS * SLOW);
    } catch (error) { errors.push(error); }
    if (existsSync(ready)) try {
      const actor = JSON.parse(readFileSync(ready, "utf8")) as { pid: number };
      await waitFor(async () => await childState(actor.pid) === "ended", "the independently leased check actor to end", CLEANUP_MS * SLOW);
    } catch (error) { errors.push(error); }
    else if (mode === "held-output" && child) errors.push(new Error("The held-output actor's native identity is unavailable"));
    if (errors.length) throw new AggregateError(errors, `Check fixture cleanup is unconfirmed; retained ${root}`);
  });
  const close = () => owner.close();
  return setupWithCleanup(() => owner.run(async () => {
    const marker = `petrina-check-${crypto.randomUUID()}`;
    lease = await createProcessLease();
    const json = import.meta.resolve("@petrina/test-support/fixture-json");
    const actor = `${mode === "cancelled-before-return" ? 'await Bun.write(Bun.stdout, "Original diagnostic\\n");' : ""} const { writeFixtureJson } = await import(${JSON.stringify(json)}); writeFixtureJson(${JSON.stringify(ready)}, { pid: process.pid }); await new Promise(() => undefined);`;
    if (mode === "held-output") {
      const worker = join(root, "worker.ts");
      writeFileSync(worker, lease.program(actor));
      writeFileSync(script, lease.program(`const { existsSync } = await import("node:fs");
const worker = Bun.spawn([process.execPath, "--no-env-file", ${JSON.stringify(worker)}], { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true });
worker.unref(); while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(10); console.log("Leader finished"); process.exit(0);`));
    } else writeFileSync(script, lease.program(actor));
    // The fixture independently owns this real handle even if the runner cannot acquire its pipes.
    child = Bun.spawn([process.execPath, "--no-env-file", script], { cwd: root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...processHost.ownedSpawn });
    void child.exited.catch(() => undefined);
    const native = child;
    if (mode === "cancelled-before-return" || mode === "running" || mode === "held-output")
      await waitFor(() => existsSync(ready), "the native actor's diagnostic before the handle is returned", undefined, { during: native.exited });
    if (mode === "running" && (typeof native.exitCode === "number" || native.signalCode)) throw new Error("The prepared check actor ended before its deadline could be tested");
    if (mode === "locked-output") locked = native.stdout.getReader();
    let output: ReadableStream<Uint8Array> = native.stdout;
    if (mode === "errored-output") {
      // The real descriptor is closed independently before substituting an already-errored stream.
      await native.stdout.cancel();
      output = new ReadableStream<Uint8Array>({ start(control) { control.error(new Error("Independently failed output")); } });
    } else if (mode === "read-error" || mode === "cancel-error") output = new Proxy(native.stdout, { get(stream, key) {
      if (key === "getReader") return () => {
        const reader = stream.getReader();
        return new Proxy(reader, { get(value, field) {
          if (field === "read") return async () => {
            await waitFor(() => existsSync(ready), "the native check before its reader fails", undefined, { during: native.exited });
            throw new Error("Controlled native reader failure");
          };
          if (field === "cancel" && mode === "cancel-error") return async () => {
            await reader.cancel();
            await reader.closed;
            cancelledReaderClosed = true;
            throw new Error("Output cancellation was not confirmed");
          };
          const member = Reflect.get(value, field, value);
          return typeof member === "function" ? member.bind(value) : member;
        } });
      };
      const member = Reflect.get(stream, key, stream);
      return typeof member === "function" ? member.bind(stream) : member;
    } });
    const supplied = new Proxy(native, { get(value, key) {
      if (key === "stdout") return output;
      const member = Reflect.get(value, key, value);
      return typeof member === "function" ? member.bind(value) : member;
    } });
    // Count both declared check commands, including the forbidden pending command, independently
    // of native cleanup's own process-list helpers. Every other native call retains its arguments.
    const nativeSpawn = Bun.spawn.bind(Bun);
    const supply = mock(() => { handed = true; if (mode === "cancelled-before-return") controller.abort(); return supplied; });
    const dispatch = ((...args: unknown[]) => {
      const first = args[0];
      const argv = Array.isArray(first) ? first : first && typeof first === "object" && "cmd" in first ? first.cmd : undefined;
      if (Array.isArray(argv) && (argv[0] === marker || argv[0] === "pending-check")) return supply();
      return Reflect.apply(nativeSpawn, undefined, args);
    }) as typeof Bun.spawn;
    const spawn = spyOn(Bun, "spawn");
    restore = () => spawn.mockRestore();
    spawn.mockImplementation(dispatch);
    return { root, close, spawning: supply, child: () => child, ready: () => existsSync(ready), cancelledReaderClosed: () => cancelledReaderClosed,
      cancel: () => controller.abort(),
      run(records?: MachineRecords, includePending = false, onSpawn?: (pid: number) => void) {
        if (used) return Promise.reject(new Error("A prepared native check can only be handed to one execution"));
        used = true;
        const checks = [{ name: options.name ?? "Native execution", argv: [marker] }, ...(includePending ? [{ name: options.pendingName ?? "Pending", argv: ["pending-check"] }] : [])];
        return owner.run(() => runChecks(root, checks, process.env, options.timeoutMs ?? (mode === "cancelled-before-return" ? 30_000 : 60_000 * SLOW),
          controller.signal, mode === "cancelled-before-return" ? undefined : join(root, "logs"), undefined, undefined, records, onSpawn, undefined, owner.beforeStart));
      },
    };
  }), close);
}
