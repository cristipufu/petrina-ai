import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkActivityDetails,
  checkOwnersLine,
  checkReasonWords,
  commandInputText,
  pipelineOf,
  stepTip,
  type ProductCheck,
} from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { writeGitProgram } from "@petrina/test-support/git-program";
import { Coordination } from "../../../src/coordination.js";
import { stepKey } from "../../../src/kernel.js";
import { WaitingForUsage } from "../../../src/usage.js";
import type { EngineOptions } from "../../engine.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { createProductRepository, waitFor, waitForFile } from "../../fixtures.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

/** An isolated engine whose tasks take turns in the check line directly: no agents, drivers or scheduling. */
async function fixture(caseOwner: EngineCaseOwner, checkRuns = 1, extraOptions: EngineOptions = {}) {
  const root = caseOwner.root;
  const options: EngineOptions = {
    agentCommand: () => undefined,
    toolProbe: privateAgentToolProbe(),
    usageCommands: { codex: null, grok: null, antigravity: null },
    terminals: () => [],
    checkRuns,
    ...extraOptions,
  };
  const engine = caseOwner.open(join(root, "data"), options);
  installSharedWorkflowFastPaths(engine, { fastCheckCapture: true });
  return caseOwner.run(engine, async () => {
    await engine.waitUntilReady();
    caseOwner.check();
    engine.schedule = () => {};
    let counter = 0;
    const add = async (title: string, worktree = false) => {
      const index = counter++;
      const productRoot = join(root, `product-${index}-${title.replace(/\W+/g, "-")}`);
      mkdirSync(productRoot, { recursive: true });
      const { path } = await createProductRepository(productRoot, { origin: "none" });
      caseOwner.check();
      const productId = installPreparedProduct(engine, {
        ...privateCloneProduct(path),
        id: `product-${index}`,
        name: title,
      });
      const task = engine.task(engine.addTask({ productId, title }))!;
      task.startedAt = 1;
      task.state = "running";
      if (worktree) executionFor(task).work.worktree = path;
      engine.commitNow();
      return task;
    };
    const checks = engine["checks"];
    const turn = (task: Awaited<ReturnType<typeof add>>) => {
      const controller = new AbortController();
      caseOwner.onStop(() => controller.abort());
      const admitted = checks["turnToRun"](executionFor(task), controller.signal);
      caseOwner.onStop(async () => {
        await admitted.then(
          (release) => release(),
          () => {},
        );
      });
      return {
        controller,
        admitted,
        outcome: admitted.then(
          () => "admitted",
          (error: unknown) => error,
        ),
      };
    };
    const held = (name = "Tests") => {
      const tag = `${name.replace(/\W+/g, "-")}-${counter++}`;
      const started = join(root, `${tag}-started`);
      const release = join(root, `${tag}-release`);
      const script = join(root, `${tag}.ts`);
      writeFileSync(
        script,
        `import { existsSync, renameSync, writeFileSync } from "node:fs";
const [started, release] = process.argv.slice(2); writeFileSync(started + ".tmp", "ready"); renameSync(started + ".tmp", started);
while (!existsSync(release)) await Bun.sleep(10);
process.exit(Bun.file(release).size ? 1 : 0);`,
      );
      caseOwner.onStop(() => {
        try {
          writeFileSync(release, "");
        } catch {}
      });
      const check: ProductCheck = { name, argv: [process.execPath, script, started, release] };
      return {
        check,
        started,
        pass: () => writeFileSync(release, ""),
        fail: () => writeFileSync(release, "fail"),
      };
    };
    return { root, options, engine, add, turn, held, checks, coordination: new Coordination(engine) };
  });
}

describe("check preparation stays current when its agent resumes", () => {
  for (const resume of ["slot wait", "screen approval", "saved conversation"] as const) {
    it(`restores Checks before review after ${resume}, then returns to the reviewer`, () =>
      engineCases.use("petrina-check-activity-", async (caseOwner) => {
        const { engine, add, checks } = await fixture(caseOwner);
        try {
          await caseOwner.run(engine, async () => {
            const task = await add("Prepare review");
            task.plan = {
              rationale: "Review",
              plannerProfileId: "sol-high",
              stages: [{ id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"] }],
            };
            task.stageIndex = 0;
            engine.s.pool.limit = 1;
            const scope = executionFor(task);
            const workflow = engine["driver"].workflow;
            const current = () => pipelineOf(repositoryView(scope), engine.s.roles).find((entry) => entry.state === "current");

            expect(workflow["reserveAgent"](task)).toBe(true);
            expect(task.agent).toBeUndefined();
            expect(task.checkActivity).toMatchObject({ phase: "preparing", productId: scope.work.productId });
            expect(checks.preparingCount).toBe(1);

            const pending = { step: stepKey(task), roleId: "check-finder", profileId: "sol-high" };
            if (resume === "slot wait") {
              engine.pendingAgentAdmissions.set(task.id, pending);
              engine.s.backgroundAgents = [
                { id: "occupied", roleId: "builder", profileId: "sol-high", label: "Other work", since: 1 },
              ];
              expect(workflow["reserveAgent"](task)).toBe(false);
              expect(task.state).toBe("waiting");
              expect(task.checkActivity).toBeUndefined();
              expect(checks.preparingCount).toBe(0);
              engine.s.backgroundAgents = [];
            } else if (resume === "screen approval") {
              task.screen = { at: 1, reason: "Inspect the product", roleId: pending.roleId, profileId: pending.profileId };
              engine.allowScreen(task.id);
              expect(task.screen.allowed).toBe(true);
            } else {
              const profile = engine.profile(pending.profileId)!;
              scope.work.conversation = {
                ...pending,
                toolId: profile.toolId,
                model: profile.model,
                sessionId: "saved-finder",
                startedAt: 1,
                briefed: true,
              };
            }
            delete task.checkActivity;
            task.state = "waiting";
            expect(workflow["reserveAgent"](task)).toBe(true);
            expect(task.agent?.roleId).toBe("check-finder");
            expect(task.holdsSlot).toBe(true);
            expect(checks.preparingCount).toBe(0);
            expect(task.checkActivity).toMatchObject({ phase: "preparing", productId: scope.work.productId, slots: 1 });
            expect(task.statusLine).toBe("Preparing automated checks");
            expect(current()).toEqual({ label: "Checks", state: "current", before: "Review" });
            expect(stepTip(current()!)).toBe("Automated checks before Review, now");

            delete task.screen;
            delete scope.work.conversation;
            engine.pendingAgentAdmissions.set(task.id, { ...pending, roleId: "code-reviewer" });
            expect(workflow["reserveAgent"](task)).toBe(true);
            expect(task.agent?.roleId).toBe("code-reviewer");
            expect(task.checkActivity).toBeUndefined();
            expect(stepTip(current()!)).toBe("Review, now");
          });
        } finally {
          await caseOwner.stop(engine);
        }
      }));
  }

  it("recognizes discovery by result kind before testing and delivery, while a Guide keeper keeps its own activity", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add } = await fixture(caseOwner);
      try {
        await caseOwner.run(engine, async () => {
          const task = await add("Prepare later checks");
          task.plan = {
            rationale: "Test and deliver",
            plannerProfileId: "sol-high",
            stages: [
              { id: "test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] },
              { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
            ],
          };
          engine.s.roles.push({ ...engine.role("check-finder")!, id: "custom-discovery", name: "Product guide" });
          const workflow = engine["driver"].workflow;
          for (const [stageIndex, before] of [
            [0, "Test"],
            [1, "Ship"],
          ] as const) {
            task.stageIndex = stageIndex;
            engine.pendingAgentAdmissions.set(task.id, {
              step: stepKey(task),
              roleId: "custom-discovery",
              profileId: "sol-high",
            });
            expect(workflow["reserveAgent"](task)).toBe(true);
            expect(task.checkActivity?.phase).toBe("preparing");
            const current = pipelineOf(repositoryView(executionFor(task)), engine.s.roles).find(
              (entry) => entry.state === "current",
            );
            expect(stepTip(current!)).toBe(`Automated checks before ${before}, now`);
            expect(task.stageIndex).toBe(stageIndex);
          }
          engine.pendingAgentAdmissions.set(task.id, { step: stepKey(task), roleId: "guide-keeper", profileId: "sol-high" });
          expect(workflow["reserveAgent"](task)).toBe(true);
          expect(task.checkActivity).toBeUndefined();
          expect(task.statusLine).toBe("Guide keeper is starting");
        });
      } finally {
        await caseOwner.stop(engine);
      }
    }));
});

describe("a task's check activity comes only from the check line", () => {
  for (const [leaves, ends] of [
    ["cancel", "passes"],
    ["pause", "fails"],
    ["prerequisite", "is stopped"],
  ] as const) {
    it(`updates the viewer's runs ahead and owner when a waiter ahead leaves (${leaves}) and the running run ${ends}`, () =>
      engineCases.use("petrina-check-activity-", async (caseOwner) => {
        const { engine, add, turn, held, checks, coordination } = await fixture(caseOwner);
        const aRun = new AbortController();
        caseOwner.onStop(() => aRun.abort());
        let aResult: Promise<unknown> | undefined;
        let tests: ReturnType<typeof held> | undefined;
        try {
          await caseOwner.run(engine, async () => {
            const [a, b, c, d] = [
              await add("Fix login retry", true),
              await add("Billing export"),
              await add("Search filters"),
              await add("Profile page"),
            ];
            tests = held();
            aResult = checks
              .runProductChecks(executionFor(a), [tests.check], aRun.signal)
              .then(
                (result) => ({ failures: nonpassingChecks(result) }),
                (error: unknown) => ({ error }),
              );
            await waitForFile(tests.started);
            await waitFor(() => a.checkActivity?.phase === "running", "the first run's command to start");
            const bTurn = turn(b);
            const cTurn = turn(c);
            const dTurn = turn(d);
            expect(engine.checkQueue.running).toBe(1);
            expect(engine.checkQueue.waiting).toBe(3);
            expect(d.statusLine).toBe("Waiting for checks · 2 runs ahead");
            expect(d.checkActivity).toMatchObject({
              phase: "waiting",
              ahead: 2,
              place: 4,
              slots: 1,
              owners: [{ taskId: a.id, title: "Fix login retry", kind: "checks" }],
            });
            expect(checkOwnersLine(d.checkActivity!.owners!, engine.s.tasks)).toBe("Tests for “Fix login retry” is running");
            expect(checkActivityDetails(d.checkActivity!, engine.s.tasks)).toEqual([
              "Tests for “Fix login retry” is running",
              "Checks have their own line, separate from agent slots.",
            ]);
            expect(b.checkActivity).toMatchObject({ phase: "waiting", ahead: 0 });
            expect(b.statusLine).toBe("Waiting for checks · next in line");

            const inspected = (await coordination.call("task.inspect", { taskId: d.id })).task as Record<string, unknown>;
            expect(inspected).toMatchObject({
              waitKind: "checks",
              waitingReason: "Waiting for checks · 2 runs ahead",
              checks: {
                phase: "waiting",
                ahead: 2,
                place: 4,
                slots: 1,
                owners: [{ title: "Fix login retry", check: "Tests", text: "Tests for “Fix login retry”" }],
              },
            });
            expect(await coordination.call("task.health", { taskId: d.id })).toMatchObject({
              waitingReason: "Waiting for checks · 2 runs ahead",
              checks: { line: "Waiting for checks · 2 runs ahead" },
            });

            if (leaves === "cancel") bTurn.controller.abort();
            else if (leaves === "pause") {
              engine.pause(b.id);
              bTurn.controller.abort();
            } else engine.setRuntimeWait(b.id, [c.id], "Needs the search filters first", "b-waits");
            const left = await bTurn.outcome;
            expect(left).toBeInstanceOf(leaves === "prerequisite" ? WaitingForUsage : Error);
            expect(b.checkActivity).toBeUndefined();

            expect(engine.checkQueue.running).toBe(1);
            expect(engine.checkQueue.waiting).toBe(2);
            expect(d.statusLine).toBe("Waiting for checks · 1 run ahead");
            expect(d.checkActivity).toMatchObject({ phase: "waiting", ahead: 1, place: 3 });

            if (ends === "passes") tests.pass();
            else if (ends === "fails") tests.fail();
            else aRun.abort();
            const finished = await aResult;
            if (ends === "passes") expect(finished).toEqual({ failures: 0 });
            else if (ends === "fails") expect(finished).toEqual({ failures: 1 });
            else expect(finished).toEqual({ error: expect.anything() });
            expect(a.checkActivity).toBeUndefined();
            expect(await cTurn.outcome).toBe("admitted");
            expect(c.checkActivity).toMatchObject({ phase: "starting" });
            expect(d.statusLine).toBe("Waiting for checks · next in line");
            expect(d.checkActivity).toMatchObject({
              phase: "waiting",
              ahead: 0,
              place: 2,
              owners: [{ taskId: c.id, title: "Search filters", kind: "checks" }],
            });
            (await cTurn.admitted)();
            expect(await dTurn.outcome).toBe("admitted");
            (await dTurn.admitted)();
          });
        } finally {
          aRun.abort();
          tests?.pass();
          await Promise.allSettled(aResult ? [aResult] : []);
          await caseOwner.stop(engine);
        }
      }));
  }

  it("names both owners with two runs at once, and never says another run comes first while a place is free", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, turn, coordination } = await fixture(caseOwner, 2);
      try {
        await caseOwner.run(engine, async () => {
          const [a, b, c, d] = [await add("First run"), await add("Second run"), await add("Third run"), await add("Viewer")];
          const first = turn(a);
          await first.admitted;
          const second = turn(b);
          expect(await second.outcome).toBe("admitted");
          expect(b.checkActivity).toMatchObject({ phase: "starting", slots: 2 });
          expect(engine.events.log.collect({ taskIds: [b.id] }, 0, 100).events.some((event) => event.wait === "checks")).toBe(
            false,
          );
          a.checkActivity = { phase: "running", since: 1, slots: 2, running: ["Tests"] };
          b.checkActivity = { phase: "running", since: 1, slots: 2, running: ["Lint"] };
          const third = turn(c);
          const viewer = turn(d);
          expect(d.checkActivity).toMatchObject({
            phase: "waiting",
            ahead: 1,
            place: 4,
            slots: 2,
            owners: [{ taskId: a.id }, { taskId: b.id }],
          });
          expect(checkActivityDetails(d.checkActivity!, engine.s.tasks)).toEqual([
            "Running now: Tests for “First run”; Lint for “Second run”",
            "Checks have their own line, separate from agent slots. Petrina runs up to 2 check runs at once.",
          ]);
          expect((await coordination.call("task.inspect", { taskId: d.id })).task).toMatchObject({
            checks: { slots: 2, ahead: 1, owners: [{ title: "First run" }, { title: "Second run" }] },
          });
          (await first.admitted)();
          expect(await third.outcome).toBe("admitted");
          expect(d.checkActivity).toMatchObject({ ahead: 0, place: 3, owners: [{ taskId: b.id }, { taskId: c.id }] });
          (await second.admitted)();
          expect(await viewer.outcome).toBe("admitted");
          (await third.admitted)();
          (await viewer.admitted)();
        });
      } finally {
        await caseOwner.stop(engine);
      }
    }));

  it("counts a run of four commands as one run ahead, never four", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, held, checks } = await fixture(caseOwner, 1, {
        runCheckCommand: (req) =>
          req.argv.length === 3 && req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === "process.exit(0)"
            ? { code: 0 }
            : undefined,
      });
      const signal = new AbortController();
      caseOwner.onStop(() => signal.abort());
      const runs: Promise<unknown>[] = [];
      let first: ReturnType<typeof held> | undefined;
      try {
        await caseOwner.run(engine, async () => {
          const [a, b, d] = [
            await add("Four checks running", true),
            await add("Four checks waiting", true),
            await add("Viewer", true),
          ];
          first = held("Type check");
          const quick = (name: string): ProductCheck => ({ name, argv: [process.execPath, "-e", "process.exit(0)"] });
          const start = (task: typeof a, list: ProductCheck[]) =>
            checks
              .runProductChecks(executionFor(task), list, signal.signal)
              .then((result) => nonpassingChecks(result))
              .catch((error: unknown) => error);
          runs.push(start(a, [first.check, quick("Tests"), quick("Lint"), quick("Build")]));
          await waitForFile(first.started);
          runs.push(start(b, [quick("Type check"), quick("Tests"), quick("Lint"), quick("Build")]));
          await waitFor(() => b.checkActivity?.phase === "waiting", "the second run to wait in the line");
          runs.push(start(d, [quick("Tests")]));
          await waitFor(() => d.checkActivity?.phase === "waiting", "the viewer to wait in the line");
          expect(engine.checkQueue.running).toBe(1);
          expect(engine.checkQueue.waiting).toBe(2);
          expect(d.checkActivity).toMatchObject({ ahead: 1, place: 3, owners: [{ taskId: a.id }] });
          expect(checkOwnersLine(d.checkActivity!.owners!, engine.s.tasks)).toBe(
            "Type check for “Four checks running” is running",
          );
          first.pass();
          expect(await runs[0]).toBe(0);
          await waitFor(
            () => d.checkActivity?.ahead === 0 && d.checkActivity.owners?.[0]?.taskId === b.id,
            "the viewer to be next",
          );
          expect(await runs[1]).toBe(0);
          expect(await runs[2]).toBe(0);
          expect([a, b, d].map((task) => task.checkActivity)).toEqual([undefined, undefined, undefined]);
        });
      } finally {
        signal.abort();
        first?.pass();
        await Promise.allSettled(runs);
        await caseOwner.stop(engine);
      }
    }));

  it("keeps the place through a pool pause, saying so, and resumes the count after it", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, turn, coordination } = await fixture(caseOwner);
      try {
        await caseOwner.run(engine, async () => {
          const [a, d] = [await add("Running"), await add("Waiting")];
          const first = turn(a);
          await first.admitted;
          const viewer = turn(d);
          expect(d.checkActivity).toMatchObject({ phase: "waiting", ahead: 0 });
          engine.setPoolPaused(true);
          engine.checkQueue.pump();
          expect(d.state).toBe("waiting");
          expect(d.statusLine).toBe("Waiting for the pool to resume");
          expect(d.checkActivity).toMatchObject({ phase: "paused", ahead: 0, place: 2 });
          expect(checkActivityDetails(d.checkActivity!, engine.s.tasks)).toContain("Keeps its place · next in line");
          expect((await coordination.call("task.inspect", { taskId: d.id })).task).toMatchObject({
            waitKind: "checks",
            waitingReason: "Waiting for the pool to resume",
          });
          const events = engine.events.log.collect({ taskIds: [d.id] }, 0, 100).events.filter((event) => event.wait === "checks");
          expect(events.map((event) => [event.kind, (event.checkActivity as { phase: string }).phase])).toEqual([
            ["task.waiting", "waiting"],
            ["task.state", "paused"],
          ]);
          const before = engine.events.log.newest;
          engine.setPoolPaused(false);
          engine.checkQueue.pump();
          expect(d.state).toBe("running");
          expect(d.statusLine).toBe("Waiting for checks · next in line");
          const resumed = engine.events.log
            .collect({ taskIds: [d.id] }, before, 100)
            .events.filter((event) => event.kind.startsWith("task."));
          expect(
            resumed.map((event) => [
              event.kind,
              event.summary,
              (event.checkActivity as { phase?: string } | undefined)?.phase,
            ]),
          ).toEqual([["task.state", "waiting → running: Waiting for checks · next in line", "waiting"]]);
          (await first.admitted)();
          expect(await viewer.outcome).toBe("admitted");
          (await viewer.admitted)();
        });
      } finally {
        await caseOwner.stop(engine);
      }
    }));

  for (const checkRuns of [1, 2]) {
    it(`leaves no check activity behind a restart, and a resumed run writes a fresh one (limit ${checkRuns})`, () =>
      engineCases.use("petrina-check-activity-", async (caseOwner) => {
        const { root, options, engine, add } = await fixture(caseOwner, checkRuns);
        let restarted: typeof engine | undefined;
        try {
          const taskId = await caseOwner.run(engine, async () => {
            const task = await add("Restarted run");
            task.checkActivity = {
              phase: "waiting",
              since: 1,
              ahead: 3,
              place: 5,
              slots: 1,
              owners: [{ taskId: "gone", title: "Gone", kind: "checks" }],
            };
            task.statusLine = "Waiting for checks · 3 runs ahead";
            engine.s.pool.paused = true;
            engine.commitNow();
            return task.id;
          });
          restarted = await caseOwner.restart(engine, join(root, "data"), options);
          await caseOwner.run(restarted, async () => {
            await restarted!.waitUntilReady();
            restarted!.schedule = () => {};
            restarted!.s.pool.paused = false;
            const loaded = restarted!.task(taskId)!;
            expect(loaded.checkActivity).toBeUndefined();
            expect(loaded.statusLine).not.toContain("Waiting for checks");
            loaded.state = "running";
            const others: (() => void)[] = [];
            for (let i = 0; i < checkRuns; i++) {
              others.push(await restarted!["checks"]["turnToRun"](executionFor(loaded), new AbortController().signal));
            }
            const waiting = restarted!["checks"]["turnToRun"](executionFor(loaded), new AbortController().signal);
            expect(loaded.checkActivity).toMatchObject({
              phase: "waiting",
              ahead: 0,
              place: checkRuns + 1,
              slots: checkRuns,
            });
            others.forEach((release) => release());
            (await waiting)();
          });
        } finally {
          if (restarted) await caseOwner.stop(restarted);
          await caseOwner.stop(engine);
        }
      }));
  }
});

describe("focused reads of a check that has not finished", () => {
  it("reports a waiting or running check as current, with no saved diagnostic yet, and keeps finished reads as they were", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, held, checks, coordination } = await fixture(caseOwner);
      const signal = new AbortController();
      caseOwner.onStop(() => signal.abort());
      const runs: Promise<unknown>[] = [];
      let tests: ReturnType<typeof held> | undefined;
      try {
        await caseOwner.run(engine, async () => {
          const [a, d] = [await add("Running checks", true), await add("Queued checks", true)];
          tests = held();
          runs.push(
            checks
              .runProductChecks(executionFor(a), [tests.check], signal.signal)
              .then((result) => nonpassingChecks(result))
              .catch((error: unknown) => error),
          );
          await waitForFile(tests.started);
          runs.push(
            checks
              .runProductChecks(executionFor(d), [tests.check], signal.signal)
              .then((result) => nonpassingChecks(result))
              .catch((error: unknown) => error),
          );
          await waitFor(
            () => d.checkActivity?.phase === "waiting" && a.checkActivity?.phase === "running",
            "one run running and one waiting",
          );
          const read = (task: typeof a) =>
            coordination.call("journey.check", { taskId: task.id, nodeId: task.journey!.at(-1)!.id, index: 0 });
          const running = await read(a);
          const waiting = await read(d);
          expect(running).toMatchObject({
            outcome: "unavailable",
            commandOutcome: "running",
            relevance: "current",
            completeness: "not-yet-saved",
            verified: false,
            message: "Tests is running now; its saved diagnostic is not available yet. Read it again after the check finishes.",
          });
          expect(waiting).toMatchObject({
            commandOutcome: "waiting",
            relevance: "current",
            activity: "Waiting for checks · next in line",
            message:
              "Tests is waiting to run; its saved diagnostic is not available yet. Read it again after the check finishes.",
          });
          for (const reply of [running, waiting]) expect(JSON.stringify(reply)).not.toContain("older evidence");
          tests.pass();
          expect(await runs[0]).toBe(0);
          expect(await runs[1]).toBe(0);
          const finished = await read(a);
          expect(finished).toMatchObject({ commandOutcome: "passed", relevance: "historical" });
          expect(finished.completeness).not.toBe("not-yet-saved");
        });
      } finally {
        signal.abort();
        tests?.pass();
        await Promise.allSettled(runs);
        await caseOwner.stop(engine);
      }
    }));

  it("still calls a stopped attempt's missing link older evidence", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, coordination } = await fixture(caseOwner);
      try {
        await caseOwner.run(engine, async () => {
          const task = await add("Stopped long ago");
          task.journey = [
            {
              id: "j1",
              kind: "petrina",
              work: "checks",
              round: 1,
              sub: 0,
              startedAt: 1,
              endedAt: 2,
              productChecks: [{ id: "check-0", attemptId: "run-0", name: "Tests", result: "pending" }],
            },
          ];
          expect(await coordination.call("journey.check", { taskId: task.id, nodeId: "j1", index: 0 })).toMatchObject({
            outcome: "unavailable",
            commandOutcome: "unfinished",
            relevance: "historical",
            completeness: "missing",
            message: "This older evidence has no original diagnostic link.",
          });
        });
      } finally {
        await caseOwner.stop(engine);
      }
    }));
});

describe("why a fresh check run is needed", () => {
  it("refreshes the recorded reason when admission captures newer code after the queue wait", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, checks } = await fixture(caseOwner, 1, {
        runCheckCommand: (req) =>
          req.argv.length === 3 && req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === "process.exit(0)"
            ? { code: 0 }
            : undefined,
      });
      const controller = new AbortController();
      caseOwner.onStop(() => controller.abort());
      let release: (() => void) | undefined;
      let pending: Promise<unknown> | undefined;
      caseOwner.onStop(() => release?.());
      try {
        await caseOwner.run(engine, async () => {
          const task = await add("Refreshed check reason", true);
          const scope = executionFor(task);
          const worktree = scope.work.worktree!;
          engine.setProductChecks(task.productId, [
            { name: "Quick", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) },
          ]);
          const change = async (name: string) => {
            writeFileSync(join(worktree, name), name);
            await gitOps.commitChanges(worktree, `Change ${name}`);
          };
          scope.work.baseSha = readWorktreeCommit(worktree)!.commit;
          expect((await checks.failing(scope, controller.signal, undefined, "review")).kind).toBe("passed");
          const earlier = JSON.stringify(task.journey!.at(-1));
          await change("task-change.txt");
          release = engine.checkQueue.hold();
          let preparations = 0;
          const running = checks.failing(scope, controller.signal, undefined, "delivery-check", async () => {
            preparations++;
            await change("new-starting-source.txt");
            scope.work.baseSha = readWorktreeCommit(worktree)!.commit;
          });
          pending = running;
          await waitFor(() => task.checkActivity?.phase === "waiting", "the changed code to wait for checks");
          expect(task.journey!.at(-1)!.checkReasons![0]!.changed).toEqual(["code"]);
          release();
          expect((await running).kind).toBe("passed");
          const reason = task.journey!.at(-1)!.checkReasons![0]!;
          expect(reason.changed).toEqual(["code", "start"]);
          expect(checkReasonWords(reason)).toContain("(main moved on)");
          expect(task.journey!.at(-1)!.checkReasons).toHaveLength(1);
          expect(JSON.stringify(task.journey![0])).toBe(earlier);
          expect(scope.work.checks!.sha).toBe(readWorktreeCommit(worktree)!.commit);
          expect(preparations).toBe(1);
          expect(task.checkActivity).toBeUndefined();
        });
      } finally {
        controller.abort();
        release?.();
        await Promise.allSettled(pending ? [pending] : []);
        await caseOwner.stop(engine);
      }
    }));

  it("records the reason from the versions both runs saved, never from the step before it", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add, coordination } = await fixture(caseOwner, 1, {
        runCheckCommand: (req) =>
          req.argv.length === 3 && req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === "process.exit(0)"
            ? { code: 0 }
            : undefined,
      });
      try {
        await caseOwner.run(engine, async () => {
          const task = await add("Reasoned checks", true);
          const scope = executionFor(task);
          const worktree = scope.work.worktree!;
          engine.setProductChecks(task.productId, [
            { name: "Quick", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) },
          ]);
          const signal = new AbortController().signal;
          const latest = () =>
            task.journey!.flatMap((step) => (step.checkReasons ?? []).map((reason) => ({ node: step.id, reason }))).at(-1)!;
          const count = () => task.journey!.flatMap((step) => step.checkReasons ?? []).length;
          const change = async (file: string) => {
            writeFileSync(join(worktree, file), file);
            await gitOps.commitChanges(worktree, `Change ${file}`);
          };

          const start = readWorktreeCommit(worktree)!.commit;
          expect((await engine["checks"].failing(scope, signal, undefined, "review")).kind).toBe("passed");
          expect(latest().reason).toEqual({ attemptId: "run-0", purpose: "review", changed: [] });
          expect(checkReasonWords(latest().reason)).toBe("Before review: no earlier run of these checks");
          // The same code reuses the saved run: nothing runs, nothing new to explain.
          expect((await engine["checks"].failing(scope, signal, undefined, "acceptance")).kind).toBe("passed");
          expect(count()).toBe(1);

          const first = { nodeId: latest().node, sha: scope.work.checks!.sha, tree: scope.work.checks!.tree };
          scope.work.baseSha = start;
          await change("first.txt");
          expect((await engine["checks"].failing(scope, signal, undefined, "delivery-check")).kind).toBe("passed");
          expect(latest().reason).toMatchObject({
            purpose: "delivery-check",
            earlier: { ...first, attemptId: "run-0", passed: true },
            changed: ["code"],
          });
          expect(checkReasonWords(latest().reason)).toBe(
            `Before your delivery check: the code changed since the passing run in step ${first.nodeId.slice(1)}`,
          );

          scope.work.baseSha = readWorktreeCommit(worktree)!.commit;
          await change("second.txt");
          expect((await engine["checks"].failing(scope, signal, undefined, "publishing")).kind).toBe("passed");
          expect(latest().reason.changed).toEqual(["code", "start"]);
          expect(checkReasonWords(latest().reason)).toContain("(main moved on)");
          const node = latest().node;
          expect(
            engine.events.log
              .collect({ taskIds: [task.id] }, 0, 500)
              .events.find((event) => event.kind === "node.started" && event.nodeId === node)!.summary,
          ).toEndWith(` started: ${checkReasonWords(latest().reason)}`);
          const read = await coordination.call("journey.node", { taskId: task.id, nodeId: node });
          expect(read.checkReasons).toEqual([{ ...latest().reason, words: checkReasonWords(latest().reason) }]);

          scope.work.branch = "main";
          writeGitProgram(join(worktree, ".git", "hooks", "pre-commit"), "exit 0");
          expect((await engine["checks"].failing(scope, signal, undefined, "acceptance")).kind).toBe("passed");
          expect(latest().reason.changed).toEqual(["definitions"]);
          expect((await engine["checks"].failing(scope, signal, undefined, "delivery-check")).kind).toBe("passed");
          expect(latest().reason.changed).toEqual(["hooks"]);
          expect(checkReasonWords(latest().reason)).toMatch(
            /^Before your delivery check: the code is unchanged since the passing run in step \d+, but the repository's commit hooks must be checked again$/,
          );
          for (const step of task.journey!) {
            for (const reason of step.checkReasons ?? []) {
              expect(checkReasonWords(reason)).not.toMatch(/review passed/i);
            }
          }
        });
      } finally {
        await caseOwner.stop(engine);
      }
    }));
});

describe("prerequisite waits keep their own words", () => {
  it("says a resumed task waits for its prerequisite to land, never for a free slot", () =>
    engineCases.use("petrina-check-activity-", async (caseOwner) => {
      const { engine, add } = await fixture(caseOwner);
      try {
        await caseOwner.run(engine, async () => {
          const [task, required] = [await add("Resumed work"), await add("Runtime fix")];
          engine.setRuntimeWait(task.id, [required.id], "Needs the runtime fix first", "resume-wait");
          engine.pause(task.id);
          engine.resume(task.id);
          expect(task.state).toBe("waiting");
          expect(task.statusLine).toBe("Waiting for “Runtime fix” to land");
          const events = engine.events.log
            .collect({ taskIds: [task.id] }, 0, 200)
            .events.filter((event) => event.kind === "task.state" && event.to === "waiting");
          expect(events.at(-1)).toMatchObject({ wait: "dependencies", reason: "Waiting for “Runtime fix” to land" });
          expect(events.some((event) => String(event.summary).includes("free slot"))).toBe(false);
        });
      } finally {
        await caseOwner.stop(engine);
      }
    }));
});
