
import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun } from "@petrina/core";

import { type Result } from "../../../src/coordination.js";

import { CHECK_EXIT_UNREPORTED } from "../../../src/checks.js";

import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
import { interfaceClient } from "../../fixtures/coordinator-interface.js";
const owners = coordinatorApiFixtures();
const { fixture } = owners;
afterAll(() => owners.close());

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} rejects stale saved-explanation continuations without returning a fresh partial page`, async () => {
    const { home, engine, task } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
    const directory = join(home, "checks", task.id);
    mkdirSync(directory, { recursive: true });
    const logPath = join(directory, "empty.log");
    writeFileSync(logPath, "");
    const run: CheckRun = { name: "Check", command: "stand-in", ok: false, ms: 1, output: "", logComplete: false };
    executionFor(task).work.checks = { at: 1, results: [run] };
    const token = "stale-explanation-key-12345678901";
    const server = serve(engine, { port: 0, token });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
    const call = interfaceClient(kind, home);
    try {
      for (const source of ["empty", "missing", "legacy"]) {
        run.logPath = source === "empty" ? logPath : source === "missing" ? join(directory, "missing.log") : undefined;
        run.output = "Original saved explanation\n".repeat(100);
        const args = { taskId: task.id, index: 0, limit: 40 };
        const first = await call("journey.check", args);
        expect(first.shortened).toBe(true);
        const continued = await call("journey.check", { ...args, cursor: first.next });
        expect(continued.text).toBe(run.output.slice(40, 80));
        const savedNext = (first.savedResult as Result).next;
        run.output = "Changed saved explanation\n".repeat(100);
        for (const read of [{ ...args, cursor: first.next }, { ...args, section: "result", cursor: savedNext }]) {
          const changed = await call("journey.check", read, 5);
          expect(changed.outcome).toBe("changed");
          expect(changed.message).toContain("changed");
          expect(changed.message).toContain("beginning");
          expect(changed).not.toHaveProperty("text");
          expect(changed).not.toHaveProperty("next");
          expect(changed).not.toHaveProperty("savedResult");
        }
        expect((await call("journey.check", args)).text).toBe(run.output.slice(0, 40));
      }
    } finally { server.stop(true); }
  });
}

it("labels older check logs without creation identity as unverified and uses only their saved excerpt", async () => {
  const { home, task, coordination } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
  const directory = join(home, "checks", task.id);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "older.log");
  const saved = "The failure excerpt saved with this older run.";
  writeFileSync(logPath, "Unverified raw file content");
  executionFor(task).work.checks = { at: 1, results: [{ name: "Check", command: "stand-in", ok: false, ms: 1, output: saved, logPath, logComplete: true }] };
  const result = await coordination.call("journey.check", { taskId: task.id, index: 0 });
  expect(result.completeness).toBe("legacy-unverified");
  expect(result.text).toBe(saved);
  expect(result.text).not.toContain("Unverified raw file content");
  expect(result.message).toContain("no record of which file Petrina created");
  // Identity alone is not enough, even for the real file: its facts are never rebuilt from the path.
  const info = statSync(logPath, { bigint: true });
  const identified: CheckRun = { name: "Check", command: "stand-in", ok: false, ms: 1, output: saved, logPath, logComplete: true, logFileIdentity: { device: info.dev.toString(), inode: info.ino.toString() } };
  executionFor(task).work.checks = { at: 2, results: [identified] };
  const partial = await coordination.call("journey.check", { taskId: task.id, index: 0 });
  expect(partial.completeness).toBe("legacy-unverified");
  expect(partial.text).toBe(saved);
  expect(partial.message).toContain("no record of the length and beginning");
  identified.logError = "The log could not be fingerprinted.";
  identified.logComplete = false;
  const failedCapture = await coordination.call("journey.check", { taskId: task.id, index: 0 });
  expect(failedCapture.completeness).toBe("incomplete");
  expect(failedCapture.text).toBe(saved);
  expect(failedCapture.commandOutcome).toBe("failed");
});

it("paginates legacy saved failure details independently of a long or empty process log", async () => {
  const { home, task, coordination } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
  const directory = join(home, "checks", task.id);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "recorded.log");
  const saved = "Could not finish: saved explanation\n" + "Additional recorded details\n".repeat(1000);
  const run: CheckRun = { name: "Check", command: "stand-in", ok: false, ms: 1, output: saved, logPath, logComplete: false };
  executionFor(task).work.checks = { at: 1, results: [run] };
  for (const log of ["", "Original process output\n".repeat(2000)]) {
    writeFileSync(logPath, log);
    let page = await coordination.call("journey.check", { taskId: task.id, index: 0, limit: 100 });
    expect(String(page.text).length).toBeLessThanOrEqual(100);
    const savedResult = page.savedResult as Result;
    expect(String(savedResult.text).length).toBeLessThanOrEqual(100);
    expect(savedResult.shortened).toBe(true);
    expect(savedResult.section).toBe("result");
    let full = String(savedResult.text), next = savedResult.next;
    while (next) {
      page = await coordination.call("journey.check", { taskId: task.id, index: 0, section: "result", cursor: next });
      full += page.text;
      next = page.next;
    }
    expect(full).toBe(saved);
    if (!log) {
      page = await coordination.call("journey.check", { taskId: task.id, index: 0, limit: 100 });
      full = String(page.text);
      while (page.next) { page = await coordination.call("journey.check", { taskId: task.id, index: 0, cursor: page.next }); full += page.text; }
      expect(full).toBe(saved);
    }
    run.output = "Changed recorded explanation";
    expect((await coordination.call("journey.check", { taskId: task.id, index: 0, section: "result", cursor: savedResult.next })).outcome).toBe("changed");
    run.output = saved;
  }
});

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} inspects compact checkpoints and follows only the selected saved diagnostics`, async () => {
  const { home, engine, task } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
  const work = executionFor(task).work;
  const results = ["Types", "Build", "Tests", "Shell"].map((name) => ({ name, command: `check ${name}`, ok: true, ms: 1, output: "Successful output\n".repeat(1000) }));
  work.checks = { at: 1, sha: "recorded", tree: "tree", definition: "definition", current: true, results };
  const itemId = `compact-${kind}`;
  engine.s.inbox.push({ id: itemId, taskId: task.id, kind: "delivery", title: "Inspect the delivery", body: "The actual checkpoint request", at: 2, blocking: false });
  const token = "compact-checkpoint-key-1234567890123";
  const server = serve(engine, { port: 0, token });
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  const call = interfaceClient(kind, home);
  try {
    const page = await call("inbox.inspect", { itemId });
    expect(page.shortened).toBe(false);
    expect(page.decisions).toEqual(["inbox.approve", "inbox.changes"]);
    expect(page.revision).toBeString();
    expect(String(page.text)).not.toContain("Successful output");
    const view = JSON.parse(String(page.text));
    expect(view.request.body).toBe("The actual checkpoint request");
    expect(view.products[0].checks.results).toHaveLength(4);
    const { operation, ...args } = view.products[0].checks.results[2].diagnostics.read;
    const diagnostic = await call(operation, { ...args, section: "result", limit: 100 });
    expect(diagnostic.commandOutcome).toBe("passed");
    expect(diagnostic.text).toBe(results[2]!.output.slice(0, 100));
    work.checks.results = [{ ...results[2]!, ok: false, output: "A failure to start was saved separately" }];
    const changed = await call(operation, { ...args, section: "result" }, 5);
    expect(changed.outcome).toBe("changed");
    expect(changed.text).toBeUndefined();
    const failed = await call("inbox.inspect", { itemId });
    expect(failed.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
    expect(JSON.parse(String(failed.text)).products[0].checks.results[0].diagnostics.savedResult.text).toBe("A failure to start was saved separately");
    work.checks.results[0]!.output = "é" + "🙂".repeat(3000) + "\n" + CHECK_EXIT_UNREPORTED;
    const unknown = await call("inbox.inspect", { itemId });
    expect(unknown.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
    const check = JSON.parse(String(unknown.text)).products[0].checks.results[0];
    expect(check.commandOutcome).toBe("unknown");
    expect(check.exitUnreported).toBe(true);
    for (const preview of [check.diagnostics.savedResult, check.diagnostics.savedResultEnding])
      expect(preview.text).toBe(Buffer.from(preview.text).toString("utf8"));
    expect(check.diagnostics.savedResultEnding.text).toContain(CHECK_EXIT_UNREPORTED);
    const { operation: savedOperation, ...savedArgs } = check.diagnostics.savedResultRead;
    const continued = await call(savedOperation, { ...savedArgs, cursor: check.diagnostics.savedResult.next });
    expect(check.diagnostics.savedResult.text + continued.text).toBe(work.checks.results[0]!.output);
  } finally { server.stop(true); }
});
}
