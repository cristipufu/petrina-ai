import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";
import { linkSync, mkdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { type Result } from "../../../src/coordination.js";

import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
import { interfaceClient } from "../../fixtures/coordinator-interface.js";
import { createdFailure, retarget } from "../../fixtures/coordinator-check-log.js";
const owners = coordinatorApiFixtures();
const { fixture } = owners;
afterAll(() => owners.close());

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} refuses a hard-linked connection file and preserves ordinary logs, symbolic-link refusal and paginated saved explanations`, async () => {
    const { home, engine, task } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
    const directory = join(home, "checks", task.id);
    mkdirSync(directory, { recursive: true });
    const saved = "Ordinary failure note\n" + "Additional saved explanation\n".repeat(1000);
    const run = await createdFailure(home, task.id, saved);
    run.output = saved;
    const logPath = run.logPath!;
    executionFor(task).work.checks = { at: 1, results: [run] };
    task.journey = [{ id: "recorded-check", kind: "petrina", work: "checks", startedAt: 1, endedAt: 2, round: 1, sub: 0, productChecks: [{ name: run.name, result: "fail", run }] }];
    const token = "hard-link-test-connection-key-123";
    const server = serve(engine, { port: 0, token });
    const connection = { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token };
    writeConnection(home, connection);
    const call = interfaceClient(kind, home);
    try {
      unlinkSync(logPath);
      linkSync(join(home, "engine.json"), logPath);
      // The connection is replaced atomically during ordinary startup/restart. The alias then
      // has one link, so link-count checks alone accept the old connection file as a check log.
      writeConnection(home, connection);
      for (const nodeId of [undefined, "recorded-check"]) {
        const args = { taskId: task.id, index: 0, ...(nodeId ? { nodeId } : {}) };
        let page = await call("journey.check", args);
        expect(JSON.stringify(page).includes(token)).toBe(false);
        expect(page.completeness).toBe("missing-file");
        expect(page.commandOutcome).toBe("failed");
        const savedResult = page.savedResult as Result;
        let text = String(page.text);
        while (page.next) {
          page = await call("journey.check", { ...args, cursor: page.next });
          expect(JSON.stringify(page).includes(token)).toBe(false);
          text += page.text;
        }
        expect(text).toBe(saved);
        text = String(savedResult.text);
        let next = savedResult.next;
        while (next) {
          page = await call("journey.check", { ...args, section: "result", cursor: next });
          expect(JSON.stringify(page).includes(token)).toBe(false);
          text += page.text;
          next = page.next;
        }
        expect(text).toBe(saved);
      }
      // Removing the original name also leaves the alias alone. Restore discovery with
      // a new file so both interfaces can read the still-running temporary engine.
      unlinkSync(logPath);
      linkSync(join(home, "engine.json"), logPath);
      unlinkSync(join(home, "engine.json"));
      writeConnection(home, connection);
      for (const nodeId of [undefined, "recorded-check"]) {
        const page = await call("journey.check", { taskId: task.id, index: 0, ...(nodeId ? { nodeId } : {}) });
        expect(JSON.stringify(page)).not.toContain(token);
        expect(page.completeness).toBe("missing-file");
        expect(page.commandOutcome).toBe("failed");
        expect(page.text).toBe(saved.slice(0, 8000));
      }
      unlinkSync(logPath);
      fixtureFiles.fileLink(join(home, "engine.json"), logPath);
      const symbolic = await call("journey.check", { taskId: task.id, index: 0 });
      expect(JSON.stringify(symbolic).includes(token)).toBe(false);
      expect(symbolic.completeness).toBe("missing-file");
      expect(symbolic.text).toBe(saved.slice(0, 8000));
      unlinkSync(logPath);
      const ordinary = "Original ordinary diagnostic\n".repeat(500);
      retarget(run, await createdFailure(home, task.id, ordinary));
      let page = await call("journey.check", { taskId: task.id, index: 0 });
      expect(page.completeness).toBe("complete");
      let text = String(page.text);
      while (page.next) { page = await call("journey.check", { taskId: task.id, index: 0, cursor: page.next }); text += page.text; }
      expect(text).toBe(ordinary);
      expect(text.includes(token)).toBe(false);
    } finally { server.stop(true); }
  });
}

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} refuses a substituted connection file carrying the recorded device and file number`, async () => {
    const { home, engine, task } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
    const log = "Original process diagnostic\n".repeat(400);
    const saved = "Ordinary saved explanation\n".repeat(400);
    const run = await createdFailure(home, task.id, log);
    run.output = saved;
    const logPath = run.logPath!;
    executionFor(task).work.checks = { at: 1, results: [run] };
    task.journey = [{ id: "recorded-check", kind: "petrina", work: "checks", startedAt: 1, endedAt: 2, round: 1, sub: 0, productChecks: [{ name: run.name, result: "fail", run }] }];
    const itemId = "substituted-preview";
    engine.s.inbox.push({ id: itemId, taskId: task.id, kind: "delivery", title: "Inspect the delivery", body: "Check the recorded diagnostics", at: 2, blocking: false });
    const token = "fixed-number-test-connection-key-1";
    const server = serve(engine, { port: 0, token });
    const connection = { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token };
    writeConnection(home, connection);
    const call = interfaceClient(kind, home);
    try {
      const args = { taskId: task.id, index: 0, limit: 40 };
      const first = await call("journey.check", args);
      expect(first.completeness).toBe("complete");
      expect(first.text).toBe(log.slice(0, 40));
      unlinkSync(logPath);
      linkSync(join(home, "engine.json"), logPath);
      unlinkSync(join(home, "engine.json"));
      writeConnection(home, connection);
      // Linux can give a removed log's number to the next file. Record the substitute's own device
      // and number, so every platform reaches that state without depending on the allocator.
      const alias = statSync(logPath, { bigint: true });
      expect(alias.nlink).toBe(1n);
      run.logFileIdentity = { device: alias.dev.toString(), inode: alias.ino.toString() };
      for (const nodeId of [undefined, "recorded-check"]) {
        const read = { taskId: task.id, index: 0, ...(nodeId ? { nodeId } : {}) };
        const page = await call("journey.check", read);
        expect(JSON.stringify(page)).not.toContain(token);
        expect(page.completeness).toBe("missing-file");
        expect(page.commandOutcome).toBe("failed");
        expect(page.text).toBe(saved.slice(0, 8000));
        expect((page.savedResult as Result).text).toBe(saved.slice(0, 1000));
        const continued = await call("journey.check", { ...read, cursor: page.next });
        expect(JSON.stringify(continued)).not.toContain(token);
        expect(continued.text).toBe(saved.slice(8000));
      }
      // The genuine log's continuation is refused rather than continued in the substitute.
      const stale = await call("journey.check", { ...args, cursor: first.next }, 5);
      expect(stale.outcome).toBe("changed");
      expect(JSON.stringify(stale)).not.toContain(token);
      expect(stale).not.toHaveProperty("text");
      const inspected = await call("inbox.inspect", { itemId });
      expect(JSON.stringify(inspected)).not.toContain(token);
      expect(inspected.shortened).toBe(false);
      const diagnostics = JSON.parse(String(inspected.text)).products[0].checks.results[0].diagnostics;
      expect(diagnostics.completeness).toBe("missing-file");
      expect(diagnostics.savedResult.text).toBe(saved.slice(0, 500));
      expect(diagnostics.processExcerpt).toBeUndefined();
    } finally { server.stop(true); }
  });
}

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} rejects log shortcuts and replaced-file continuations while preserving ordinary logs and excerpts`, async () => {
    const { home, engine, task } = await fixture({ prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
    const directory = join(home, "checks", task.id);
    mkdirSync(directory, { recursive: true });
    const log = "Original diagnostic near the beginning\n" + "Remaining diagnostic line\n".repeat(10);
    const run = await createdFailure(home, task.id, log);
    run.output = "Saved ordinary failure excerpt";
    const logPath = run.logPath!;
    const timestamp = new Date("2020-01-01T00:00:00Z");
    utimesSync(logPath, timestamp, timestamp);
    executionFor(task).work.checks = { at: 1, results: [run] };
    const token = "private-test-connection-key-12345";
    const server = serve(engine, { port: 0, token });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
    const call = interfaceClient(kind, home);
    try {
      const args = { taskId: task.id, index: 0, limit: 40 };
      const first = await call("journey.check", args);
      expect(first.text).toBe(log.slice(0, 40));
      renameSync(logPath, join(directory, "retired.log"));
      fixtureFiles.fileLink(join(home, "engine.json"), logPath);
      const linkedDirectory = join(directory, "shortcut");
      fixtureFiles.directoryLink(home, linkedDirectory);
      const insideLink = join(directory, "inside-link.log");
      fixtureFiles.fileLink(join(directory, "retired.log"), insideLink);
      for (const location of [logPath, join(linkedDirectory, "engine.json"), insideLink]) {
        run.logPath = location;
        const unavailable = await call("journey.check", args);
        expect(unavailable.completeness).toBe("missing-file");
        expect(unavailable.text).toBe(run.output);
        expect(JSON.stringify(unavailable).includes(token)).toBe(false);
        const stale = await call("journey.check", { ...args, cursor: first.next }, 5);
        expect(stale.outcome).toBe("changed");
        expect(stale.message).toContain("beginning");
        expect(stale).not.toHaveProperty("savedResult");
        expect(JSON.stringify(stale).includes(token)).toBe(false);
      }
      unlinkSync(logPath);
      const fresh = await createdFailure(home, task.id, log);
      renameSync(fresh.logPath!, logPath);
      utimesSync(logPath, timestamp, timestamp);
      retarget(run, fresh, logPath);
      // Same name, length and timestamp; a new physical file still needs a fresh read.
      expect((await call("journey.check", { ...args, cursor: first.next }, 5)).outcome).toBe("changed");
      let page = await call("journey.check", args), full = String(page.text);
      while (page.next) { page = await call("journey.check", { ...args, cursor: page.next }); full += page.text; }
      expect(full).toBe(log);
    } finally { server.stop(true); }
  });
}
