
import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";

import { join } from "node:path";
import type { CheckRun } from "@petrina/core";

import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";
import { engineEnv, runChecks, SLOW } from "../../support.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
import { interfaceClient } from "../../fixtures/coordinator-interface.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());
const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] };

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} reads saved startup failures beside real process output, including historical evidence after restart`, async () => {
  return owners.use(async ({ home, engine, task, owner: lifetime }) => {

    const runs = await runChecks(home, [
      { name: "Missing", argv: [join(home, "no-such-check")] },
      { name: "Failed", argv: [process.execPath, "-e", 'console.error("Error printed by the check"); process.exit(1)'] },
      { name: "Quiet", argv: [process.execPath, "-e", "process.exit(0)"] },
    ], engineEnv(home), 10000 * SLOW, undefined, join(home, "checks", task.id));
    expect(typeof runs[0]!.logFileIdentity?.device).toBe("string");
    expect(typeof runs[0]!.logFileIdentity?.inode).toBe("string");
    expect(runs.map((run) => run.logFileLength)).toEqual([0, Buffer.byteLength("Error printed by the check\n"), 0]);
    expect(runs.every((run) => /^[0-9a-f]{64}$/.test(run.logFileBeginning ?? ""))).toBe(true);
    expect(runs[0]!.output).toContain("Could not start:");
    executionFor(task).work.checks = { at: 1, sha: "original", results: runs };
    task.journey = [{ id: "original-checks", kind: "petrina", work: "checks", startedAt: 1, endedAt: 2, round: 1, sub: 0, productChecks: runs.map((run) => ({ name: run.name, result: run.ok ? "pass" : "fail", run })) }];
    const token = "check-outcome-key-123456789012345";
    lifetime.check();
    let server = serve(engine, { port: 0, token });
    lifetime.onStop(() => server.stop(true));
    const connect = () => writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
    connect();
    const call = interfaceClient(kind, home);
    try {
      for (const nodeId of [undefined, "original-checks"]) {
        const read = (index: number) => call("journey.check", { taskId: task.id, index, ...(nodeId ? { nodeId } : {}) });
        const missing = await read(0);
        expect(missing.text).toBe(runs[0]!.output);
        expect(missing.commandOutcome).toBe("unavailable");
        expect(missing.reportedOk).toBe(false);
        expect(missing.completeness).toBe("incomplete");
        expect(missing.source).toBe("saved-result");
        expect(missing.savedResult).toHaveProperty("text", runs[0]!.output);
        const failed = await read(1);
        expect(failed.text).toBe("Error printed by the check\n");
        expect(failed.commandOutcome).toBe("failed");
        expect(failed.completeness).toBe("complete");
        const quiet = await read(2);
        expect(quiet.text).toBe("");
        expect(quiet.commandOutcome).toBe("passed");
        expect(quiet.completeness).toBe("complete");
      }
      executionFor(task).work.checks = { at: 3, sha: "later", results: [runs[2]!] };
      task.state = "paused";
      await server.stop(true);
      await engine.shutdown();
      const restarted = await lifetime.restart(engine, lifetime.root, { ...options, admissionsClosed: true });
      lifetime.check();
      server = serve(restarted, { port: 0, token });
      connect();
      const original = await call("journey.check", { taskId: task.id, nodeId: "original-checks", index: 0 });
      expect(original.text).toBe(runs[0]!.output);
      expect(original.commandOutcome).toBe("unavailable");
      expect(original.reportedOk).toBe(false);
      expect(original.relevance).toBe("historical");
      const facts = ({ logFileIdentity, logFileLength, logFileBeginning }: CheckRun) => ({ logFileIdentity, logFileLength, logFileBeginning });
      const restored = restarted.task(task.id)!;
      expect(restored.journey!.find((node) => node.id === "original-checks")!.productChecks!.map((check) => facts(check.run!))).toEqual(runs.map(facts));
      expect(executionFor(restored).work.checks!.results.map(facts)).toEqual([facts(runs[2]!)]);
      const failed = await call("journey.check", { taskId: task.id, nodeId: "original-checks", index: 1 });
      expect(failed.text).toBe("Error printed by the check\n");
      expect(failed.completeness).toBe("complete");
    } finally { await server.stop(true); }

  }, { prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
});
}
