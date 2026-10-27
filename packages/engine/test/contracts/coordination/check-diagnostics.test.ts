import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Coordination } from "../../../src/coordination.js";

import { runChecks, SLOW } from "../../support.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("preserves original long diagnostics after later checks and a restart, and reports unavailable evidence honestly", async () => {
  return owners.use(async ({ e, c, home, taskId, owner: lifetime }) => {
    const t = e.task(taskId)!;
    const directory = join(home, "checks", taskId);
    mkdirSync(directory, { recursive: true });
    const prefix = "Original failure near the beginning\n", repeated = "long output\n";
    const original = prefix + repeated.repeat(9000);
    const source = `process.stdout.write(${JSON.stringify(prefix)} + ${JSON.stringify(repeated)}.repeat(9000)); process.exit(1)`;
    const [run] = await runChecks(home, [{ name: "Tests", argv: [process.execPath, "-e", source] }], process.env, 10_000 * SLOW, undefined, directory);
    run!.output = original.slice(-6000);
    t.journey = [
      {
        id: "checks",
        kind: "petrina",
        work: "checks",
        round: 1,
        sub: 0,
        startedAt: 1,
        endedAt: 2,
        productChecks: [{ name: "Tests", result: "fail", run: run! }],
        outcome: "Failed",
        reason: "Back to builder",
      },
    ];
    executionFor(t).work.checks = { at: 3, sha: "newer", results: [{ name: "Tests", command: "test stand-in", ok: true, ms: 1, output: "pass" }] };
    let page = await c.call("journey.check", { taskId, nodeId: "checks", index: 0 });
    expect(page.text).toStartWith("Original failure");
    expect(page.commandOutcome).toBe("failed");
    expect(page.relevance).toBe("historical");
    expect(page.completeness).toBe("complete");
    let all = String(page.text);
    const next = page.next;
    e.commitNow();
    await e.shutdown();
    const restarted = await lifetime.restart(e, lifetime.root, { admissionsClosed: true, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    const focused = new Coordination(restarted);
    while (page.next) {
      page = await focused.call("journey.check", { taskId, nodeId: "checks", index: 0, cursor: page.next });
      all += page.text;
    }
    expect(all).toBe(original);
    writeFileSync(run!.logPath!, "Changed");
    expect((await focused.call("journey.check", { taskId, nodeId: "checks", index: 0, cursor: next })).outcome).toBe("changed");
    const old = restarted.task(taskId)!;
    delete old.journey![0]!.productChecks![0]!.run;
    expect((await focused.call("journey.check", { taskId, nodeId: "checks", index: 0 })).outcome).toBe("unavailable");
    expect((await focused.call("journey.check", { taskId, index: 0 })).completeness).toBe("excerpt-only");
  });
});
});

describe("focused coordination and durable decisions", () => {
it("reports missing, unfinished and incomplete diagnostics separately, and keeps UTF-8 pages intact", async () => {
  return owners.use(async ({ e, c, home, taskId }) => {

    const directory = join(home, "checks", taskId);
    mkdirSync(directory, { recursive: true });
    const original = "é🙂λ".repeat(10);
    const [run] = await runChecks(home, [{ name: "Check", argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(original)}); process.exit(1)`] }], process.env, 10_000 * SLOW, undefined, directory);
    run!.logComplete = false;
    run!.interrupted = true;
    executionFor(e.task(taskId)!).work.checks = {
      at: 1,
      results: [run!],
    };
    let page = await c.call("journey.check", { taskId, index: 0, limit: 1 }),
      all = String(page.text);
    expect(page.commandOutcome).toBe("unfinished");
    expect(page.completeness).toBe("incomplete");
    while (page.next) {
      page = await c.call("journey.check", { taskId, index: 0, limit: 1, cursor: page.next });
      all += page.text;
    }
    expect(all).toBe(original);
    executionFor(e.task(taskId)!).work.checks!.results[0]!.logPath = join(directory, "missing.log");
    expect((await c.call("journey.check", { taskId, index: 0 })).completeness).toBe("missing-file");
  });
});
});
