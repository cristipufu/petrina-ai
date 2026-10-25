import { mock, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
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

/** Real leased children and native streams, with only the read/acquisition fault substituted. */
export async function checkExecutionFixture(mode: "plain" | "read-error" | "cancel-error" | "errored-output" | "locked-output" | "held-output" | "cancelled-before-return") {
  const root = tempDir("petrina-check-execution-"), ready = join(root, "ready.json"), script = join(root, "check.ts");
  const marker = `petrina-check-${crypto.randomUUID()}`, controller = new AbortController();
  let lease: ProcessLease | undefined, child: Child | undefined, locked: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let running: ReturnType<typeof runChecks> | undefined, restore = () => {}, closing: Promise<void> | undefined;
  let cancelledReaderClosed = false;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    try { restore(); } catch (error) { errors.push(error); }
    controller.abort();
    try { await lease?.close(); } catch (error) { errors.push(error); }
    if (child) try {
      if (await stopOwnedProcess(child, { graceMs: CLEANUP_MS * SLOW, forceMs: CLEANUP_MS * SLOW }, arm) !== "confirmed") throw new Error("The check fixture's native child did not stop");
    } catch (error) { errors.push(error); }
    try { await locked?.cancel(); } catch (error) { errors.push(error); }
    try { locked?.releaseLock(); } catch (error) { errors.push(error); }
    try { await running; } catch (error) { errors.push(error); }
    if (existsSync(ready)) try {
      const actor = JSON.parse(readFileSync(ready, "utf8")) as { pid: number };
      await waitFor(async () => await childState(actor.pid) === "ended", "the independently leased check actor to end", CLEANUP_MS * SLOW);
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `Check fixture cleanup is unconfirmed; retained ${root}`);
    removeDir(root);
  })();
  return setupWithCleanup(async () => {
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
    if (mode === "cancelled-before-return") await waitFor(() => existsSync(ready), "the native cancellation diagnostic before the handle is returned", undefined, { during: native.exited });
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
    const supply = mock(() => { if (mode === "cancelled-before-return") controller.abort(); return supplied; });
    const dispatch = ((...args: unknown[]) => {
      const first = args[0];
      const argv = Array.isArray(first) ? first : first && typeof first === "object" && "cmd" in first ? first.cmd : undefined;
      if (Array.isArray(argv) && (argv[0] === marker || argv[0] === "pending-check")) return supply();
      return Reflect.apply(nativeSpawn, undefined, args);
    }) as typeof Bun.spawn;
    const spawn = spyOn(Bun, "spawn").mockImplementation(dispatch);
    restore = () => spawn.mockRestore();
    return { root, close, spawning: supply, child: () => child, ready: () => existsSync(ready), cancelledReaderClosed: () => cancelledReaderClosed,
      run(records?: MachineRecords, includePending = false, onSpawn?: (pid: number) => void) {
        const checks = [{ name: "Native execution", argv: [marker] }, ...(includePending ? [{ name: "Pending", argv: ["pending-check"] }] : [])];
        running = runChecks(root, checks, process.env, mode === "cancelled-before-return" ? 30_000 : 60_000 * SLOW,
          controller.signal, mode === "cancelled-before-return" ? undefined : join(root, "logs"), undefined, undefined, records, onSpawn);
        void running.catch(() => undefined); return running;
      },
    };
  }, close);
}
