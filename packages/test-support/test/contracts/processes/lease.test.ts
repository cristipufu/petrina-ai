import { afterAll, expect, it } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childState } from "@petrina/platform/process-tree";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { CLEANUP_MS, CommandFailure, runCommand, type CommandResult, type Started } from "@petrina/test-support/commands";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { SLOW } from "@petrina/test-support/slow";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";

const root = tempDir("petrina-process-lease-");
const children = new Set<Actor>(), leases = new Set<ProcessLease>();
let closing = false;
const finishEvery = async (work: readonly Promise<unknown>[]) => {
  const results = await Promise.allSettled(work);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Lease fixture cleanup is unconfirmed; private files retained");
};
const owners = new FixtureOperations({
  label: "Native lease fixture", allowanceMs: CLEANUP_MS * SLOW,
  arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  stop() {
    closing = true;
    const request = (stop: () => Promise<unknown>) => { try { return stop(); } catch (error) { return Promise.reject(error); } };
    return finishEvery([...leases].map(lease => request(() => lease.close())).concat([...children].map(child => request(() => child.stop()))));
  },
  dispose() {
    removeDir(root);
    try { lstatSync(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new Error("The native lease fixture root was not removed");
  },
});
type NativeActor = Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
const start = (program: string, input: "ignore" | "pipe" = "ignore") => {
  if (closing) throw new Error("The native lease fixture is closing");
  const controller = new AbortController();
  let child: NativeActor | undefined, entered = false, completed: CommandResult | undefined;
  let resolve!: (value: CommandResult) => void, reject!: (error: unknown) => void;
  const completion = new Promise<CommandResult>((done, failed) => { resolve = done; reject = failed; });
  void completion.catch(() => undefined);
  const ownership = completion.then(() => undefined, error => {
    if (error instanceof CommandFailure && (error.cleanup === "confirmed" || (!entered && error.cleanup === "none" && (error.reason === "start" || error.reason === "cancelled")))) return;
    throw error;
  });
  void ownership.catch(() => undefined);
  void completion.then(value => { completed = value; }, () => undefined);
  let stopping: Promise<void> | undefined;
  const record = {
    get pid() { if (!child) throw new Error("No native actor handle was returned"); return child.pid; },
    get exitCode() { return child?.exitCode ?? null; },
    get result() { return completed; }, completion,
    exited: completion.then(result => result.code),
    kill(signal: NodeJS.Signals) { if (child && child.exitCode == null && child.signalCode == null) child.kill(signal); },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        let failure: { error: unknown } | undefined;
        try { record.kill("SIGKILL"); } catch (error) { failure = { error }; controller.abort(); }
        try { await settleCommandAfterStop({ result: completion, abort: () => controller.abort() }); }
        catch (error) { if (failure) throw new AggregateError([failure.error, error], "Native actor stop and settlement failed"); throw error; }
        if (failure) throw failure.error;
      })();
      return stopping;
    },
  };
  void record.exited.catch(() => undefined);
  children.add(record);
  void owners.run(() => {
    const actual = runCommand([process.execPath, "-e", program], { cwd: root, signal: controller.signal,
      start(argv, settings) {
        entered = true;
        child = Bun.spawn(argv, { ...settings, stdin: input, stdout: "pipe", stderr: "pipe", windowsHide: true });
        void child.exited.catch(() => undefined);
        const actual = child;
        return { pid: actual.pid, exited: actual.exited, stdout: actual.stdout, stderr: actual.stderr,
          get exitCode() { return actual.exitCode; }, get signalCode() { return actual.signalCode; }, kill: signal => actual.kill(signal),
        } satisfies Started;
      },
    });
    void actual.then(resolve, reject);
    return ownership;
  }).catch(() => undefined);
  return record;
};
type Actor = ReturnType<typeof start>;
const stopped = async (child: Actor) => {
  await waitFor(() => child.result, "the fixture actor to exit and drain its output", 5_000, { during: child.completion });
  return child.exited;
};
const forceStop = (child: Actor) => child.stop();
afterAll(() => owners.close());

async function withOwner(work: (owner: ProcessLease) => Promise<void>): Promise<void> {
  const owner = await owners.run(async () => {
    const lease = await createProcessLease(); leases.add(lease);
    if (closing) { await lease.close(); throw new Error("Lease fixture acquisition completed after closing"); }
    return lease;
  });
  await setupWithCleanup(() => work(owner), () => owner.close());
  await owner.close();
}

it("stops an actor after a failure before any child record is captured", () => withOwner(async owner => {
  const ready = join(root, "failed-ready");
  const actor = start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); await new Promise(() => {});`));
  try {
    const failure = await rejectionOf((async () => {
      try {
        await waitFor(() => existsSync(ready), "the actor to wait before release", undefined, { during: actor.completion });
        throw new Error("Controlled failure before capture");
      } finally { await owner.close(); }
    })());
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Controlled failure before capture");
    expect(await stopped(actor)).toBe(78);
    await owner.close();
  } finally { try { await owner.close(); } finally { await forceStop(actor); } }
}));

it("refuses an actor started after teardown without executing its body", () => withOwner(async owner => {
  const ran = join(root, "late-body");
  const program = owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "");`);
  await owner.close();
  const actor = start(program);
  try {
    expect(await stopped(actor)).toBe(78);
    expect(existsSync(ran)).toBe(false);
  } finally { await forceStop(actor); }
}));

it("keeps concurrent owners independent", () => withOwner(left => withOwner(async right => {
  const ready = [join(root, "left"), join(root, "right")];
  const actors = [left, right].map((owner, index) => start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ready[index])}, ""); await new Promise(() => {});`)));
  try {
    await waitFor(() => ready.every(file => existsSync(file)), "both independent actors to start", undefined, { during: Promise.all(actors.map(actor => actor.completion)) });
    await left.close();
    expect(await stopped(actors[0]!)).toBe(78);
    expect(actors[1]!.exitCode).toBeNull();
    await right.close();
    expect(await stopped(actors[1]!)).toBe(78);
  } finally { await Promise.all([left.close(), right.close()]); await Promise.all(actors.map(forceStop)); }
})));

it("lets a completed actor exit normally while its owner stays open", () => withOwner(async owner => {
  const ran = join(root, "completed-body");
  const actor = start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "");`));
  try {
    expect(await stopped(actor)).toBe(0);
    expect(existsSync(ran)).toBe(true);
  } finally { await forceStop(actor); }
}));

it("ends an actor when its owner process dies without running teardown", async () => {
  const recipe = join(root, "abandoned-program.json"), ready = join(root, "abandoned-ready");
  const fixture = new URL("../../../src/process-lease.ts", import.meta.url).href;
  const json = new URL("../../../src/fixture-json.ts", import.meta.url).href;
  const owner = start(`process.stdin.on("end", () => process.exit(78)); process.stdin.resume();
const { createProcessLease } = await import(${JSON.stringify(fixture)});
const { writeFixtureJson } = await import(${JSON.stringify(json)});
const lease = await createProcessLease();
writeFixtureJson(${JSON.stringify(recipe)}, { program: lease.program(${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); await new Promise(() => {});`)}) });
await new Promise(() => {});`, "pipe");
  let actor: Actor | undefined;
  try {
    await waitFor(() => existsSync(recipe), "the owner to publish its complete actor recipe", undefined, { during: owner.completion });
    actor = start((JSON.parse(readFileSync(recipe, "utf8")) as { program: string }).program);
    await waitFor(() => existsSync(ready), "the actor to connect to its separate owner", undefined, { during: actor.completion });
    owner.kill("SIGKILL");
    await owner.exited;
    expect(await stopped(actor)).toBe(78);
  } finally { await forceStop(owner); if (actor) await forceStop(actor); }
});

it("lets a Worker-monitored actor finish normally after its monitor settles", () => withOwner(async owner => {
  const ran = join(root, "monitored-completed-body");
  const actor = start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, ""); console.log("completed body");`, { monitor: "worker" }));
  try {
    expect(await stopped(actor)).toBe(0);
    expect(existsSync(ran)).toBe(true);
    expect(await actor.completion).toMatchObject({ code: 0, stdout: "completed body\n", stderr: "" });
    expect(await childState(actor.pid)).toBe("ended");
  } finally { await forceStop(actor); }
}));

it("refuses a Worker-monitored late actor before its main-thread body runs", () => withOwner(async owner => {
  const ran = join(root, "monitored-late-body");
  const program = owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "");`, { monitor: "worker" });
  await owner.close();
  const actor = start(program);
  try {
    expect(await stopped(actor)).not.toBe(0);
    expect(existsSync(ran)).toBe(false);
    expect(await childState(actor.pid)).toBe("ended");
  } finally { await forceStop(actor); }
}));

for (const failure of [new Error("monitored body failed"), undefined]) it("retains a monitored body's rejection after monitor settlement: " + String(failure), () => withOwner(async owner => {
  const json = new URL("../../../src/fixture-json.ts", import.meta.url).href, receipt = join(root, "monitored-failure-" + (failure === undefined ? "undefined" : "error") + ".json");
  const body = failure === undefined ? "throw undefined;" : `throw new Error(${JSON.stringify(failure.message)});`;
  const program = owner.program(body, { monitor: "worker" });
  const actor = start(`try { ${program} } catch (error) {
const { writeFixtureJson } = await import(${JSON.stringify(json)});
writeFixtureJson(${JSON.stringify(receipt)}, { undefined: error === undefined, ...(error instanceof Error ? { message: error.message } : {}) });
process.exit(19);
}`);
  try {
    expect(await stopped(actor)).toBe(19);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(failure === undefined ? { undefined: true } : { undefined: false, message: failure.message });
    expect(await childState(actor.pid)).toBe("ended");
  } finally { await forceStop(actor); }
}));

it("ends an actually blocked main thread when its separately owned lease process dies", async () => {
  const recipe = join(root, "blocked-program.json"), ready = join(root, "blocked-main.json");
  const fixture = new URL("../../../src/process-lease.ts", import.meta.url).href;
  const json = new URL("../../../src/fixture-json.ts", import.meta.url).href;
  const body = `const { writeFixtureJson } = await import(${JSON.stringify(json)});
const { isMainThread } = require("node:worker_threads");
console.log("main thread blocking");
writeFixtureJson(${JSON.stringify(ready)}, { pid: process.pid, isMainThread });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`;
  // EOF ends Aux if the test worker dies; Aux's socket loss independently ends Actor.
  const owner = start(`process.stdin.on("end", () => process.exit(78)); process.stdin.resume();
const { createProcessLease } = await import(${JSON.stringify(fixture)});
const { writeFixtureJson } = await import(${JSON.stringify(json)});
const lease = await createProcessLease();
writeFixtureJson(${JSON.stringify(recipe)}, { program: lease.program(${JSON.stringify(body)}, { monitor: "worker" }) });
await new Promise(() => {});`, "pipe");
  let actor: Actor | undefined;
  try {
    await waitFor(() => existsSync(recipe), "Aux to publish the blocked actor's complete recipe", undefined, { during: owner.completion });
    actor = start((JSON.parse(readFileSync(recipe, "utf8")) as { program: string }).program);
    await waitFor(() => existsSync(ready), "Actor's admitted main thread to reach the synchronous blocking call", undefined, { during: actor.completion });
    expect(JSON.parse(readFileSync(ready, "utf8"))).toEqual({ pid: actor.pid, isMainThread: true });
    expect(owner.exitCode).toBeNull();
    expect(actor.exitCode).toBeNull();
    // Stop only Aux. Actor's fallback is deliberately reserved for finally after these assertions.
    owner.kill("SIGKILL");
    await owner.exited;
    expect(await stopped(actor)).not.toBe(0);
    expect(await actor.completion).toMatchObject({ stdout: "main thread blocking\n", stderr: "" });
    expect(await childState(actor.pid)).toBe("ended");
  } finally { await finishEvery([forceStop(owner), ...(actor ? [forceStop(actor)] : [])]); }
});
