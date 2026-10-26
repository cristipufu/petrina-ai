import { afterAll, afterEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { defunctProcesses } from "../../../src/defunct-process.js";
import { rejectionOf } from "../../../src/rejections.js";
import { setupWithCleanup } from "../../../src/setup-with-cleanup.js";
import { waitFor } from "../../../src/fixtures.js";
import { childState } from "@petrina/platform/process-tree";

const fixtures = defunctProcesses();
const releases = new Set<() => void>();
const close = () => { for (const release of releases) release(); return fixtures.close(); };
afterEach(close);
afterAll(close);
const present = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};

// Qualify this actual direct-child boundary before any paused multi-generation cases.
it.skipIf(process.platform === "win32")("owns native Node STOP, CONT and KILL with complete output", async () => {
  const observed = await fixtures.checkSignals();
  expect(observed).toMatchObject({ paused: true, continued: true, signal: "SIGKILL", outputClosed: true });
  expect(fixtures.retained.size).toBe(0);
});

it.skipIf(process.platform === "win32")("collects the actual defunct target before removing its case root and permits manual release", async () => {
  let root = "", pid = 0, holder = 0;
  await fixtures.use(async fixture => {
    root = fixture.root; pid = fixture.pid; holder = fixture.holderPid;
    expect(existsSync(root)).toBe(true);
    expect(await childState(pid)).toBe("ended");
    expect(present(pid)).toBe(true);
    expect(present(holder)).toBe(true);
    const first = fixture.release(), again = fixture.release();
    await Promise.all([first, again]);
    expect(again).toBe(first);
    expect(present(pid)).toBe(false);
    expect(present(holder)).toBe(false);
    // Actor release never waits on or disposes its own surrounding body.
    expect(existsSync(root)).toBe(true);
  });
  expect(existsSync(root)).toBe(false);
  expect(fixtures.retained.size).toBe(0);
});

for (const failure of [new Error("Interrupted before target identity"), undefined]) it.skipIf(process.platform === "win32")(`joins actual setup cleanup and preserves ${failure === undefined ? "undefined" : "Error"} before reading its target`, async () => {
  let holder = 0, entered = false;
  const observed = await rejectionOf(fixtures.use(async () => { entered = true; }, {
    beforeRead(pid) { holder = pid; throw failure; },
  }));
  expect(observed).toBe(failure);
  expect(entered).toBe(false);
  expect(holder).toBeGreaterThan(0);
  expect(present(holder)).toBe(false);
  expect(fixtures.retained.size).toBe(0);
});

for (const failure of [new Error("Interrupted defunct body"), undefined]) it.skipIf(process.platform === "win32")(`joins actual actors after a body rejects with ${failure === undefined ? "undefined" : "Error"}`, async () => {
  let root = "", pid = 0, holder = 0;
  const observed = await rejectionOf(fixtures.use(async fixture => {
    root = fixture.root; pid = fixture.pid; holder = fixture.holderPid;
    expect(present(pid)).toBe(true);
    throw failure;
  }));
  expect(observed).toBe(failure);
  expect(present(pid)).toBe(false);
  expect(present(holder)).toBe(false);
  expect(existsSync(root)).toBe(false);
  expect(fixtures.retained.size).toBe(0);
});

it.skipIf(process.platform === "win32")("stops actual defunct actors while its owned body is held, before disposing its root", async () => {
  const gate = Promise.withResolvers<void>();
  const release = () => gate.resolve();
  releases.add(release);
  let root = "", pid = 0, holder = 0, entered = false, closed = false;
  let using: Promise<void> | undefined, closing: Promise<void> | undefined;
  const finish = async () => {
    release();
    const settled = await Promise.allSettled([using, closing, fixtures.close()]);
    releases.delete(release);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Held defunct body did not settle with its native owners");
  };
  await setupWithCleanup(async () => {
    using = fixtures.use(async fixture => {
      root = fixture.root; pid = fixture.pid; holder = fixture.holderPid;
      entered = true;
      await gate.promise;
    });
    await waitFor(() => entered, "the actual defunct body to reach its owned hold", undefined, { during: using });
    closing = fixtures.close();
    void closing.then(() => { closed = true; }, () => { closed = true; });
    await waitFor(() => !present(pid) && !present(holder), "the actual holder and target to end before releasing the body", undefined, { during: closing });
    expect(closed).toBe(false);
    expect(existsSync(root)).toBe(true);
    release();
    await Promise.all([using, closing]);
    expect(closed).toBe(true);
    expect(existsSync(root)).toBe(false);
  }, finish);
  await finish();
});

it.skipIf(process.platform === "win32")("joins reentrant close before the target receipt without replacing its original setup error", async () => {
  const failure = new Error("Reentrant defunct setup stopped before target receipt");
  let holder = 0, entered = false;
  let using: Promise<void> | undefined, closing: Promise<void> | undefined;
  const finish = async () => {
    const settled = await Promise.allSettled([using?.then(() => undefined, () => undefined), closing, fixtures.close()]);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Reentrant defunct setup cleanup was not confirmed");
  };
  await setupWithCleanup(async () => {
    using = fixtures.use(async () => { entered = true; }, {
      beforeRead(pid) {
        holder = pid;
        closing = fixtures.close();
        void closing.catch(() => undefined);
        throw failure;
      },
    });
    const observed = await rejectionOf(using);
    await closing;
    expect(observed).toBe(failure);
    expect(entered).toBe(false);
    expect(holder).toBeGreaterThan(0);
    expect(present(holder)).toBe(false);
  }, finish);
  await finish();
});
