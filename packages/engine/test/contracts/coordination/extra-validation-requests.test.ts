import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProblem } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { executionFor } from "@petrina/orchestrator";
import { extraFixture } from "../../extra-fixtures.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  it("reports distinct queue positions before registration and refuses unrelated receipts or ineligible tasks", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const secondTask = await f.add();
    f.engine.extraRecovery = true;
    const first = await f.submit("pre-register-first");
    const second = await f.submit("pre-register-second", ["probe", "pass"], secondTask.id);
    expect([first.queuePosition, second.queuePosition]).toEqual([1, 2]);
    f.engine.extraRecovery = false;
    f.engine.cancel(f.task.id); f.engine.cancel(secondTask.id);
    const other = await f.coordination.call("pool.limit", { limit: 2, requestId: "pool-change" });
    expect(other.outcome).toBe("completed");
    expect((await f.coordination.call("validation.inspect", { requestId: "pool-change" })).outcome).toBe("missing");
    for (const state of ["backlog", "paused", "done", "cancelled", "pr-open"] as const) {
      const task = await f.add(); task.state = state;
      expect((await f.coordination.call("validation.run", f.request("ineligible-" + state, ["probe", "pass"], task.id))).outcome).toBe("invalid");
    }
    const task = await f.add(); delete executionFor(task).work.savedVersion;
    expect((await f.coordination.call("validation.run", f.request("unsaved", ["probe", "pass"], task.id))).message).toContain("no saved version");

  });

  });
});

  it("keeps extra passes and failures independent of ordinary checks, findings, approvals and repair allowance", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const work = executionFor(f.task).work;
    work.checks = { at: 1, current: true, results: [{ name: "Configured suite", command: "configured", ok: false, execution: completeCheckExecution(7), output: "failure", ms: 2 }] };
    work.checkReturns = 2; work.approvedSha = "approval";
    f.engine.s.inbox.push({ id: "ordinary-delivery", taskId: f.task.id, kind: "delivery", title: "Delivery", at: Date.now(), blocking: false });
    const before = JSON.stringify({ checks: work.checks, returns: work.checkReturns, approved: work.approvedSha, findings: f.task.findings, stage: f.task.stageIndex });
    f.engine.setPoolPaused(false);
    for (const [ref, mode] of [["extra-pass", "pass"], ["extra-fail", "fail"]]) {
      const record = await f.submit(ref!, ["probe", mode!]);
      const result = await f.finished(record);
      expect(result.result).toBe(mode === "pass" ? "passed" : "failed");
      expect(JSON.stringify({ checks: work.checks, returns: work.checkReturns, approved: work.approvedSha, findings: f.task.findings, stage: f.task.stageIndex })).toBe(before);
      expect(checkProblem({ checks: work.checks })).toBe("failing");
      expect(() => f.engine.approve("ordinary-delivery")).toThrow("checks are failing or unverified");
    }
    const events = f.engine.events.log.collect({}, 0, 100).events;
    expect(events.filter(event => event.kind.startsWith("extra.")).map(event => event.kind)).toEqual(["extra.queued", "extra.started", "extra.stopping", "extra.finished", "extra.queued", "extra.started", "extra.stopping", "extra.finished"]);
    expect(events.filter(event => event.kind.startsWith("check."))).toEqual([]);

  });

  });
});

  it("refuses unsupported and invalid requests without queueing; missing local images/services are not-run", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    for (const change of [{ mode: "native" }, { options: ["--privileged"] }, { remote: "elsewhere" }, { argv: [] }, { argv: [""] }, { name: " " }, { image: "--pull" }, { taskId: "unknown" }]) {
      const reply = await f.coordination.call("validation.run", { ...f.request("refuse-" + Math.random().toString().slice(2)), ...change });
      expect(["invalid", "missing"]).toContain(reply.outcome);
      expect(f.engine.s.extraValidations ?? []).toEqual([]);
    }
    const record = await f.submit("only-one");
    expect((await f.coordination.call("validation.run", f.request("second-request"))).message).toContain("only-one");
    writeFileSync(join(f.service, "missing-image"), "missing");
    f.engine.setPoolPaused(false);
    expect((await f.finished(record)).result).toBe("not run");
    rmSync(join(f.service, "missing-image"));
    writeFileSync(join(f.service, "offline"), "missing");
    const offline = await f.submit("offline", ["probe", "pass"]);
    expect((await f.finished(offline)).result).toBe("not run");
    expect(f.engine.checkQueue.running).toBe(0);
    expect(existsSync(join(f.service, "started"))).toBe(true); // CLI creates empty service folders, never a workload
    expect(readdirSync(join(f.service, "started"))).toEqual([]);

  });

  });
});
});
it.skipIf(process.platform !== "win32")("refuses an extra run on a host without supported process-group ownership", async () => {
  return cases.use("petrina-extra-", async owner => {
  return await extraFixture(owner, async f => {
  const result = await f.coordination.call("validation.run", f.request("unsupported-host", ["probe", "pass"]));
  expect(result.outcome).toBe("invalid");
  expect(result.message).toContain("Unix host");
  expect(f.engine.s.extraValidations).toBeUndefined();
  expect(f.engine.checkQueue.running).toBe(0);

  });

  });
});
