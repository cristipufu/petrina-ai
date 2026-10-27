import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { AgentRun } from "../../../src/acp-run.js";
import { AgentBrowser } from "../../../src/browser.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { childState } from "@petrina/platform/process-tree";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { browserCleanupFixtures } from "../../fixtures/browser-cleanup-owned.js";

const observerFixtures = browserCleanupFixtures();
afterEach(() => observerFixtures.close());

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const folder = () => { const root = tempDir("petrina-session-lifetime-"); roots.push(root); return root; };
const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
const command = [process.execPath, join(import.meta.dir, "../../fixtures/session-agent.ts")];
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

for (const first of [new Error("The cleanup observer failed"), undefined]) it(`notifies both ownership observers and preserves their failures when cleanup observer throws ${first === undefined ? "undefined" : "Error"}`, async () => observerFixtures.use(async fixture => {
  const second = new Error("The process observer failed");
  const opened = await fixture.open({ probe: true, onGone() { throw first; }, onProcess() { throw second; } });
  expect(fixture.events).toEqual(["gone", "process"]);
  expect(opened.kind).toBe("error");
  if (opened.kind !== "error" || !(opened.error instanceof AggregateError)) throw new Error("An ownership observer failure disappeared");
  expect(opened.error.errors).toHaveLength(2);
  expect(opened.error.errors[0]).toBe(first);
  expect(opened.error.errors[1]).toBe(second);
  expect(fixture.gone).toBeDefined();
  await fixture.gone;
  await fixture.ended();
  expect(fixture.incomplete).toBe(0);
}));

for (const observer of ["onProcess", "onGone"] as const) for (const reopen of [false, true]) it(`reclaims a started agent when its ${observer} observer throws (${reopen ? "reopen" : "fresh"})`, async () => {
  const root = folder();
  let child: ChildProcess | undefined;
  const controller = new AbortController();
  const failure = new Error("Startup observer failed");
  try {
    const error = await rejectionOf(AgentRun.start({ profile, command, cwd: root, browser: false, signal: controller.signal, callbacks,
      ...(reopen ? { reopen: crypto.randomUUID() } : {}),
      onProcess: proc => { child = proc; if (observer === "onProcess") throw failure; },
      onGone: () => { if (observer === "onGone") throw failure; },
    }));
    expect(error).toBe(failure);
    expect(child?.pid).toBeGreaterThan(0);
    expect(await childState(child!.pid!)).toBe("ended");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => { child!.once("exit", () => resolve()); child!.once("error", () => resolve()); });
      child.kill("SIGKILL");
      await exited;
    }
  }
});
it("stops a process aborted synchronously by its ownership callback without opening a browser", async () => {
  const root = folder();
  const browser = spyOn(AgentBrowser, "start");
  try {
    for (const probe of [false, true]) {
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      const error = await AgentRun.start({ profile, cwd: root, command: [...command, "--hang"], callbacks, probe, signal: controller.signal, onProcess: process => { child = process; controller.abort(); } }).then(async run => { await run.stop(); return undefined; }, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Stopped before the agent started");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (child) await new Promise<void>(done => { if (child!.exitCode !== null || child!.signalCode !== null) done(); else child!.once("exit", () => done()); });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    }
    expect(browser).not.toHaveBeenCalled();
  } finally { browser.mockRestore(); }
});

it("releases stopped and failed runs from a shared task cancellation signal", async () => {
  const root = folder();
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  for (let n = 0; n < 3; n++) {
    const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: controller.signal, probe: true });
    await run.stop();
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  }
  await expectRejection(AgentRun.start({ profile, cwd: root, command: [...command, "--logged-out"], callbacks, signal: controller.signal, probe: true }));
  expect(getEventListeners(controller.signal, "abort").length).toBe(before);
});

it("does not retain completed turns on the live agent's process", async () => {
  const root = folder();
  let child: ChildProcess | undefined;
  const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
  try {
    const before = child!.listenerCount("exit");
    for (let n = 0; n < 3; n++) {
      await run.prompt("You are the Researcher in Petrina. Hand back notes.");
      expect(child!.listenerCount("exit")).toBe(before);
    }
  } finally { await run.stop(); }
});
