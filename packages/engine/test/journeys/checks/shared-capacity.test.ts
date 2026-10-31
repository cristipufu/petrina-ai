import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { fakeAgentSessions } from "../../fixtures/fake-agent-sessions.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { describe as originalDescribe } from "bun:test";
import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "../..");

import { afterAll, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyProblems, slotUses, type Task } from "@petrina/core";


import { createProductRepository, Fakes, waitFor } from "../../fixtures.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());




originalDescribe("tasks' checks take turns on one machine", () => {
it("runs one task's checks while the other waits its turn, and both get through", async () => {
  return engineCases.use("petrina-check-turns-", async caseOwner => {
    const root = caseOwner.root;

    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ checks: "slow" });
    const hold = join(root, "hold-check");
    const runs = join(root, "check-runs");
    const check = join(root, "check.ts");
    const script = join(fakes.dir, "agents.json");
    caseOwner.onStop(() => rmSync(hold, { force: true }));
    writeFileSync(hold, "");
    // Hold the first check until another task really waits, however far apart their agents finish.
    // The shared lock also makes an overlapping run fail instead of silently passing the fixture.
    writeFileSync(check, `import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
const lock = ${JSON.stringify(join(root, "checking"))};
mkdirSync(lock);
try {
  appendFileSync(${JSON.stringify(runs)}, process.cwd() + "\\n");
  while (existsSync(${JSON.stringify(hold)})) await Bun.sleep(20);
} finally { rmSync(lock, { recursive: true }); }
`);
    writeFileSync(script, JSON.stringify({ checks: [{ name: "Held check", argv: [process.execPath, check], why: "Waits until the other task is in line" }] }));
    const engine = installSharedWorkflowFastPaths(
      caseOwner.open(join(root, "data"), {
        agentCommand: () => [process.execPath, join(TEST_FIXTURE_ROOT, "fake-agent.ts"), fakes.dir, `--script=${script}`],
        startAgentSession: fakeAgentSessions(fakes, { scriptPath: script }),
        toolProbe: privateAgentToolProbe(),
        runCheckCommand: async (req) => {
          if (req.argv[0] !== process.execPath || req.argv[1] !== check) return undefined;
          const lock = join(root, "checking");
          mkdirSync(lock);
          try {
            appendFileSync(runs, `${req.cwd}\n`);
            while (existsSync(hold) && !req.signal?.aborted) await Bun.sleep(20);
            return { code: req.signal?.aborted ? 130 : 0 };
          } finally {
            rmSync(lock, { recursive: true });
          }
        },
      }),
      { skipDriverPrepare: true, skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true },
    );
    // Admission reserves the slot before Git/environment preparation starts the actual command.
    // Exercise that gap deliberately instead of relying on how quickly this machine starts checks.
    let startFirst!: () => void;
    const firstStart = new Promise<void>((resolve) => { startFirst = resolve; });
    caseOwner.onStop(() => startFirst());
    const runAll = engine["checks"]["runAll"].bind(engine["checks"]);
    let first = true;
    engine["checks"]["runAll"] = async (...args) => {
      if (first) { first = false; await firstStart; }
      return runAll(...args);
    };
    let waitedBeforeStart = false;
    let occupiedDuringChecks: number | undefined;
    let waitingStep: { taskId: string; stepId: string; startedAt: number; evidence: NonNullable<Task["journey"]>[number]; running: { name: string; startedAt?: number }; activity: Task["checkActivity"]; line: string } | undefined;
    const unsubscribe = engine.subscribe(() => {
      const state = engine.activeState();
      const task = state.tasks.find((task) => task.checkActivity?.phase === "waiting");
      if (!task || waitingStep) return;
      // A place is reserved before the diagnostic log opens and start is reported.
      // Compare the running check with its queued peer only after that report.
      const running = state.tasks.flatMap((entry) => entry.journey?.at(-1)?.productChecks ?? []).find((check) => check.result === "running");
      if (!running) {
        waitedBeforeStart = true;
        startFirst();
        return;
      }
      const step = task.journey!.at(-1)!;
      // Snapshot the evidence and assert after the run. An assertion thrown by an update listener
      // would abort the check and replace its pending evidence with "stopped" during cleanup.
      occupiedDuringChecks = slotUses(state).length;
      waitingStep = { taskId: task.id, stepId: step.id, startedAt: step.startedAt, evidence: JSON.parse(JSON.stringify(step)) as typeof step, running: { ...running }, activity: structuredClone(task.checkActivity), line: task.statusLine };
    });
    caseOwner.onStop(unsubscribe);
    try {
      const productId = await caseOwner.run(engine, async () => {
        const { path: clone } = await createProductRepository(root, { origin: "none" });
        await engine.waitUntilReady(); caseOwner.check();
        return installPreparedProduct(engine, privateCloneProduct(clone));
      });
      const ids = [engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" }), engine.addTask({ productId, title: "Add a farewell", description: "[no-check]" })];
      await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        // The progress event can precede process startup. Wait for the check's own marker as well
        // before releasing it, so the lock still proves the two commands never overlap.
        if (waitingStep && existsSync(runs)) rmSync(hold, { force: true });
        const tasks = ids.map((id) => state.tasks.find((entry) => entry.id === id) as Task | undefined);
        if (tasks.some((task) => task?.state === "failed")) throw new Error("a task failed");
        return ids.every((id) => state.inbox.some((item) => item.taskId === id && item.kind === "delivery"));
      }, "both delivery checks", 90_000);
      expect(waitedBeforeStart).toBe(true);
      expect(occupiedDuringChecks).toBe(0);
      expect(waitingStep).toBeDefined();
      expect(waitingStep!.evidence).toMatchObject({ kind: "petrina", work: "checks" });
      expect(waitingStep!.evidence.endedAt).toBeUndefined();
      expect(waitingStep!.evidence.productChecks).toEqual([expect.objectContaining({ name: "Held check", result: "pending" })]);
      expect(waitingStep!.running.name).toBe("Held check");
      expect(waitingStep!.running.startedAt).toBeNumber();
      // The waiting task names the run ahead of it from the line itself: one whole run, by its task.
      const other = ids.find((id) => id !== waitingStep!.taskId)!;
      expect(waitingStep!.line).toBe("Waiting for checks · next in line");
      expect(waitingStep!.activity).toMatchObject({ phase: "waiting", ahead: 0, place: 2, slots: 1, owners: [{ taskId: other, title: engine.task(other)!.title, kind: "checks" }] });
      const task = engine.getState().tasks.find((task) => task.id === waitingStep!.taskId)!;
      expect(task.journey!.find((step) => step.id === waitingStep!.stepId)).toMatchObject({ startedAt: waitingStep!.startedAt, end: "done", outcome: "The check passes" });
      for (const task of engine.getState().tasks) expect(journeyProblems(task)).toEqual([]);
      const checked = new Set(readFileSync(runs, "utf8").trim().split("\n").map((path) => realpathSync.native(path)));
      const copies = new Set(ids.map((id) => realpathSync.native(engine.getState().tasks.find((task) => task.id === id)!.worktree!)));
      expect(checked).toEqual(copies);
    } finally {
      unsubscribe();
      startFirst();
      rmSync(hold, { force: true });
      await caseOwner.stop(engine);
    }

  });
});
});
