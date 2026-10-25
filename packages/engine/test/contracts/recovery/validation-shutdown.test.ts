import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "../..");
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine } from "../../engine.js";
import { waitFor } from "../../fixtures.js";
import { executionFor } from "@petrina/orchestrator";

import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { WaitClock } from "@petrina/storage/worklog";


import { ExtraFixtures } from "../../extra-fixtures.js";

const owned = new ExtraFixtures();
const { engines } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const mode of ["none", "queued", "running"] as const) it(`saves ordinary work and closes its log immediately on shutdown with ${mode} extra work`, async () => {
    const f = await fixture();
    const ordinary = await f.add(); ordinary.title = "Unrelated interrupted turn";
    const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
    const controller = new AbortController();
    const run = await AgentRun.start({ profile, cwd: executionFor(ordinary).work.worktree!, command: [process.execPath, join(TEST_FIXTURE_ROOT, "fake-agent.ts"), "--tool=codex"],
      callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" }, signal: controller.signal, browser: false });
    f.engine.runs.set(ordinary.id, run); f.engine.drivers.set(ordinary.id, controller);
    const turn = f.engine.tracking.turn(ordinary, { roleId: "builder", profile, waits: new WaitClock(), journeyId: ordinary.journey!.at(-1)!.id, agentSeat: "main" }, run, "HANG-FOREVER please", "first", controller.signal).catch(() => undefined);
    let releaseCleanup = () => {};
    let stopped: Promise<void> | undefined;
    try {
      await waitFor(() => run.prompting, "the ordinary turn to start");
      const record = mode === "none" ? undefined : await f.submit("shutdown-" + mode);
      if (mode === "running") { f.engine.setPoolPaused(false); await f.started(record!); f.engine.setPoolPaused(true); }
      let entered = false;
      if (mode === "running") {
        const cleanup = f.engine.extraValidations["container"].cleanup.bind(f.engine.extraValidations["container"]);
        const released = new Promise<void>(resolve => { releaseCleanup = resolve; });
        f.engine.extraValidations["container"].cleanup = async record => { entered = true; await released; return cleanup(record); };
      }
      // No earlier save contains this last ordinary change. Shutdown must save it before
      // any slow cleanup, and a turn ending during that cleanup must remain unfinished.
      ordinary.description = "Saved at the instant Petrina stops";
      stopped = f.engine.shutdown();
      if (mode !== "none") {
        expect(f.engine.store.loadActive()!.tasks.find(task => task.id === ordinary.id)!.description).toBe(ordinary.description);
        expect(f.engine.store.loadActive()!.extraValidations).toHaveLength(1);
      }
      await turn;
      let stoppedEvidence: ExtraValidation | undefined;
      if (mode === "running") {
        await waitFor(() => entered, "container cleanup to wait for its release");
        expect(f.engine.tracking.log.turns({ taskId: ordinary.id })[0]!.end).toBeUndefined();
        stoppedEvidence = structuredClone(f.engine.s.extraValidations![0]!);
      }
      releaseCleanup(); await stopped;
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      const [lost] = replacement.tracking.log.turns({ taskId: ordinary.id });
      expect(lost).toMatchObject({ end: "lost" });
      expect(lost!.workMs).toBeUndefined();
      expect(replacement.task(ordinary.id)!.description).toBe(ordinary.description);
      const usage = replacement.usage({ view: "task", taskId: ordinary.id });
      expect(usage.time.atLeast && usage.tokens.atLeast).toBe(true);
      expect(usage.atLeast).toContain("cut off when Petrina stopped");
      if (record) {
        const recovered = replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation;
        expect(recovered.state).toBe(mode === "queued" ? "queued" : "finished");
        if (mode === "running") {
          expect(recovered.result).toBe("stopped");
          expect(recovered.run!.logComplete).toBe(true);
          expect(recovered.run).toEqual(stoppedEvidence!.run);
          expect(recovered.durationMs).toBe(stoppedEvidence!.durationMs);
          expect(recovered.endedAt).toBe(stoppedEvidence!.endedAt);
          expect(readdirSync(join(f.service, "containers"))).toEqual([]);
          expect(existsSync(record.snapshot)).toBe(false);
        }
      }
    } finally { releaseCleanup(); await (stopped ?? f.engine.shutdown()); await turn; }
  });
});
