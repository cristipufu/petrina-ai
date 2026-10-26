import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { CommandFailure } from "@petrina/test-support/commands";
import { childState } from "@petrina/platform/process-tree";
import { rejectionOf } from "@petrina/test-support/rejections";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { engineProcessCases, tempDir, type EngineProcess } from "../../support.js";

const cases = engineProcessCases();
afterEach(() => cases.close());

const hello = { type: "ready", owned: true, url: "http://localhost/fixture", token: "private-fixture" } as const;
const interactive = ["-e", `console.log(${JSON.stringify(JSON.stringify(hello))}); await Bun.stdin.text();`];

it("closes admission synchronously and never starts another app or operation after case cleanup", async () => {
  const root = tempDir("petrina-process-closed-"), owners = cases.open(root);
  await owners.close();
  let starts = 0, spawn: ReturnType<typeof spyOn> | undefined;
  try {
    spawn = spyOn(Bun, "spawn");
    spawn.mockImplementation(() => { starts++; throw new Error("Closed ownership must not invoke a starter"); });
    const app = await rejectionOf(owners.app(root, interactive));
    const operation = await rejectionOf(owners.prepare(async () => { starts++; }));
    expect(app).toBeInstanceOf(Error);
    expect(operation).toBeInstanceOf(Error);
    expect(starts).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(owners.close()).toBe(owners.close());
  } finally { spawn?.mockRestore(); await owners.close(); }
});

it("owns a pending startup before its observer can reenter cleanup and cannot hand out a late app", async () => {
  const root = tempDir("petrina-process-start-close-"), owners = cases.open(root);
  let child: EngineProcess["proc"] | undefined, closing: Promise<void> | undefined, repeated: Promise<void> | undefined;
  const pending = owners.app(root, ["-e", "await Bun.stdin.text();"], { onProcess(proc) {
    child = proc;
    closing = owners.close();
    repeated = owners.close();
  } });
  try {
    const error = await rejectionOf(pending);
    expect(error).toBeInstanceOf(Error);
    await closing;
    expect(repeated).toBe(closing);
    expect(child).toBeDefined();
    expect(await childState(child!.pid)).toBe("ended");
    expect(child!.exitCode ?? child!.signalCode).not.toBeNull();
    expect(existsSync(root)).toBe(false);
  } finally { await owners.close(); }
});

it("joins the actual generation before disposal and rejects manual work on its stopped identity", async () => {
  const root = tempDir("petrina-process-generation-"), owners = cases.open(root);
  try {
    const engine = await owners.app(root, interactive);
    expect(engine.hello).toEqual(hello);
    await owners.stop(engine);
    expect(await engine.exited(10_000)).toBe(0);
    expect(await childState(engine.proc.pid)).toBe("ended");
    expect(existsSync(root)).toBe(true);
    let stale = 0;
    const error = await rejectionOf(owners.run(engine, async () => { stale++; }));
    expect(error).toBeInstanceOf(Error);
    expect(stale).toBe(0);
  } finally { await owners.close(); }
  expect(existsSync(root)).toBe(false);
});

it("keeps a post-ready setup failure while independently joining its actual app before disposal", async () => {
  const root = tempDir("petrina-process-setup-failed-"), owners = cases.open(root);
  const failure = new Error("The fixture's post-ready preparation failed");
  let engine: EngineProcess | undefined;
  try {
    // The only asynchronous setup effect is the already registered app startup; the
    // synchronous setup rejection must preserve its original identity after cleanup.
    const error = await rejectionOf(setupWithCleanup(async () => {
      engine = await owners.app(root, interactive);
      throw failure;
    }, () => owners.close()));
    expect(error).toBe(failure);
    expect(engine).toBeDefined();
    expect(await engine!.exited(10_000)).toBe(0);
    expect(await childState(engine!.proc.pid)).toBe("ended");
    expect(existsSync(root)).toBe(false);
  } finally { await owners.close(); }
});

it("independently stops a raw peer that ignores input EOF before the fixture allowance is spent", async () => {
  const root = tempDir("petrina-process-raw-stop-"), owners = cases.open(root);
  const peer = owners.command(root, ["-e", 'console.log("ready"); setInterval(() => {}, 1000);']);
  try {
    expect(await peer.line()).toBe("ready");
    await owners.close();
    const failure = await rejectionOf(peer.completion);
    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).reason).toBe("cancelled");
    expect((failure as CommandFailure).cleanup).toBe("confirmed");
    expect((failure as CommandFailure).stdout).toBe("ready\n");
    expect(await childState(peer.pid)).toBe("ended");
    expect(existsSync(root)).toBe(false);
  } finally { await owners.close(); }
});

it("publishes collection close and every peer admission before a stop callback can reenter", async () => {
  const first = tempDir("petrina-process-close-first-"), second = tempDir("petrina-process-close-peer-");
  let peer!: ReturnType<typeof cases.open>, reentrant: Promise<void> | undefined, denied: Promise<unknown> | undefined;
  let openError: unknown, late = 0;
  cases.open(first, { stopPeers() {
    reentrant = cases.close();
    try { cases.open(second); } catch (error) { openError = error; }
    denied = peer.prepare(async () => { late++; });
    void denied.catch(() => undefined);
  } });
  peer = cases.open(second);
  const closing = cases.close();
  await closing;
  expect(reentrant).toBe(closing);
  expect(openError).toBeInstanceOf(Error);
  expect(await rejectionOf(denied!)).toBeInstanceOf(Error);
  expect(late).toBe(0);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(false);
});

it("hook cleanup owns a held body and refuses its late native launch after release", async () => {
  const root = tempDir("petrina-process-held-body-");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let spawn: ReturnType<typeof spyOn> | undefined, running: Promise<unknown> | undefined, closing: Promise<void> | undefined, starts = 0;
  try {
    spawn = spyOn(Bun, "spawn");
    spawn.mockImplementation(() => { starts++; throw new Error("No native starter may run after the hook closed admission"); });
    running = cases.use(root, async owners => {
      entered.resolve();
      await release.promise;
      return rejectionOf(owners.app(root, interactive));
    });
    void running.catch(() => undefined);
    await entered.promise;
    closing = cases.close();
    release.resolve();
    const error = await running;
    await closing;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("closing");
    expect(starts).toBe(0);
    expect(existsSync(root)).toBe(false);
  } finally {
    release.resolve();
    try { await Promise.allSettled([...(running ? [running] : []), closing ?? cases.close()]); }
    finally { spawn?.mockRestore(); }
  }
});
