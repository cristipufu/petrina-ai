import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkActivityDetails, checkHoldLine, type ExtraValidation } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import * as processTree from "@petrina/platform/process-tree";
import { rejectionOf } from "@petrina/test-support/rejections";
import { ExtraContainer } from "../../../src/extra-container.js";
import { WaitingForUsage } from "../../../src/usage.js";
import type { EngineOptions } from "../../engine.js";
import { preparedServiceExtraFixture, type ExtraFixture } from "../../extra-fixtures.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { createProductRepository, waitFor } from "../../fixtures.js";

const runQuickOrdinaryCheck: NonNullable<EngineOptions["runCheckCommand"]> = (req) =>
  req.argv.length === 3 && req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === "process.exit(0)"
    ? { code: 0 }
    : undefined;

function fastExtraFixture<T>(
  owner: EngineCaseOwner,
  body: (fixture: ExtraFixture) => Promise<T>,
  options: EngineOptions = {},
): Promise<T> {
  return preparedServiceExtraFixture(
    owner,
    body,
    { runCheckCommand: runQuickOrdinaryCheck, ...options },
    { fastClientStop: true, actorLease: false, commandLease: false, scriptedNonHoldRuns: true },
  );
}

const cases = engineCaseFixtures();
afterAll(() => cases.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  it("counts a waiting extra validation as one run ahead, then names it as the running owner", () =>
    cases.use("petrina-extra-", async (owner) =>
      preparedServiceExtraFixture(
        owner,
        async (f) => {
          f.engine.setPoolPaused(false);
          const productTask = await f.add();
          productTask.state = "running";
          const viewer = await f.add();
          viewer.state = "running";
          const busy = await f.engine.checkQueue.acquire(new AbortController().signal);
          owner.onStop(() => busy());
          const record = await f.submit("extra-ahead", ["probe", "hold"]);
          expect(record.queuePosition).toBe(2);
          const controller = new AbortController();
          owner.onStop(() => controller.abort());
          const run = f.engine["checks"]
            .runProductChecks(
              executionFor(viewer),
              [{ name: "Ordinary check", argv: [process.execPath, "-e", "process.exit(0)"] }],
              controller.signal,
            )
            .then(
              (result) => ({ failures: nonpassingChecks(result) }),
              (error: unknown) => ({ error }),
            );
          owner.onStop(async () => {
            await Promise.allSettled([run]);
          });
          try {
            await waitFor(
              () => viewer.checkActivity?.phase === "waiting",
              "the product check to wait behind the extra validation",
            );
            expect(viewer.checkActivity).toMatchObject({ ahead: 1, place: 3 });
            expect(viewer.statusLine).toBe("Waiting for checks · 1 run ahead");
            busy();
            await f.started(record);
            await waitFor(
              () => viewer.checkActivity?.owners?.[0]?.kind === "extra",
              "the extra validation to hold the running place",
            );
            expect(viewer.checkActivity).toMatchObject({
              phase: "waiting",
              ahead: 0,
              place: 2,
              owners: [{ taskId: f.task.id, kind: "extra", name: "Required Linux suite" }],
            });
            expect(checkActivityDetails(viewer.checkActivity!, f.engine.s.tasks)[0]).toBe(
              `Extra validation “Required Linux suite” for “${f.task.title}” is running`,
            );
            expect((f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation).queuePosition).toBeUndefined();
            f.release(record);
            expect((await f.finished(record)).result).toBe("passed");
            expect(await run).toEqual({ failures: 0 });
          } finally {
            busy();
            controller.abort();
            await run;
            await owner.stop(f.engine);
          }
        },
        { runCheckCommand: runQuickOrdinaryCheck },
        { fastClientStop: true, actorLease: false },
      ),
    ));

  it("writes one queued line when submitted and one when it joins, never for a new wording of the same prerequisite wait", () =>
    cases.use("petrina-extra-", async (owner) =>
      fastExtraFixture(owner, async (f) => {
        try {
          const first = await f.add();
          const second = await f.add();
          first.title = "Fix the runtime";
          second.title = "Update the image";
          f.engine.setRuntimeWait(f.task.id, [first.id, second.id], "Both fixes are required", "two-prerequisites");
          const record = await f.submit("two-prerequisites-extra", ["probe", "pass"]);
          const queuedLines = () =>
            f.task.timeline.filter(
              (line) =>
                line.text.startsWith("Extra validation") &&
                !line.text.includes("running") &&
                !line.text.includes("passed") &&
                !line.text.includes("Stopping"),
            );
          const queuedEvents = () =>
            f.engine.events.log
              .collect({ taskIds: [f.task.id] }, 0, 200)
              .events.filter((event) => event.kind === "extra.queued");
          expect(record.queuePosition).toBeUndefined();
          expect(queuedLines().map((line) => line.text)).toEqual([
            "Extra validation “Required Linux suite”: Waiting for this task's prerequisites before joining the check queue. Waiting for “Fix the runtime” and 1 more to land. Working edits are not included.",
          ]);
          const land = (task: typeof first) => {
            const work = executionFor(task).work;
            work.delivery = "local";
            work.landed = { branch: "main", sha: work.savedVersion!.commit };
            task.state = "done";
            f.engine.schedule();
          };
          land(first);
          const reworded = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
          expect(reworded.waitingReason).toContain("Waiting for “Update the image” to land.");
          expect(queuedLines()).toHaveLength(1);
          expect(queuedEvents()).toHaveLength(1);
          land(second);
          const joined = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
          expect(joined.waitingReason).toBeUndefined();
          expect(joined.queuePosition).toBe(1);
          expect(queuedLines().map((line) => line.text).at(-1)).toBe(
            "Extra validation “Required Linux suite” queued at place 1. Working edits are not included.",
          );
          expect(queuedLines()).toHaveLength(2);
          expect(queuedEvents()).toHaveLength(2);
          expect(f.task.timeline.some((line) => line.text.includes("Required tasks have landed"))).toBe(false);
          f.engine.setPoolPaused(false);
          expect((await f.finished(record)).result).toBe("passed");
        } finally {
          await owner.stop(f.engine);
        }
      }),
    ));

  it("keeps each product's run, place and timeline lines its own on a shared task while its checkpoint stays the main activity", () =>
    cases.use("petrina-extra-", async (owner) =>
      fastExtraFixture(owner, async (f) => {
        try {
          const secondRoot = join(f.root, "second-product");
          mkdirSync(secondRoot, { recursive: true });
          const { path: worktree } = await createProductRepository(secondRoot, { origin: "none" });
          const productId = installPreparedProduct(f.engine, {
            ...privateCloneProduct(worktree),
            id: "second-product",
            name: "Second product",
          });
          const first = executionFor(f.task).work;
          const savedVersion = readWorktreeCommit(worktree)!;
          f.task.repositories = [
            { ...first, delivery: first.delivery ?? "local", completedStages: first.completedStages ?? [] },
            { productId, worktree, delivery: "local", completedStages: [], savedVersion },
          ];
          delete f.task.repository;
          f.task.activeProductId = f.productId;
          const statusLine = f.task.statusLine;
          const records: ExtraValidation[] = [];
          for (const [product, name] of [
            [productId, "Second product suite"],
            [f.productId, "First product suite"],
          ] as const) {
            const reply = await f.coordination.call("validation.run", {
              ...f.request(`two-products-${name.replace(/ /g, "-")}`, ["probe", "pass"]),
              productId: product,
              name,
            });
            expect(reply.outcome).toBe("pending");
            records.push(reply.validation as ExtraValidation);
          }
          expect(records.map((record) => [record.productId, record.queuePosition])).toEqual([
            [productId, 1],
            [f.productId, 2],
          ]);
          expect(f.task.activeProductId).toBe(f.productId);
          expect(f.task.statusLine).toBe(statusLine);
          expect(f.task.checkActivity).toBeUndefined();
          f.engine.setPoolPaused(false);
          for (const record of records) expect((await f.finished(record)).result).toBe("passed");
          for (const record of records) {
            const lines = f.task.timeline.filter((line) => line.text.includes(`“${record.name}”`));
            expect(lines.length).toBeGreaterThanOrEqual(3);
            expect(lines.map((line) => line.productId)).toEqual(lines.map(() => record.productId));
          }
          expect(f.task.activeProductId).toBe(f.productId);
        } finally {
          await owner.stop(f.engine);
        }
      }),
    ));

  for (const evidence of ["reused number", "unreadable list", "list lost after stopping", "owned client"] as const) {
    it(`carries the recorded cleanup explanation into waiting checks and task health while capacity stays held (${evidence})`, () =>
      cases.use("petrina-extra-", async (owner) =>
        preparedServiceExtraFixture(
          owner,
          async (f) => {
            f.engine.setPoolPaused(false);
            const record = await f.submit("explained-cleanup-" + evidence.replace(/ /g, "-"));
            await f.started(record);
            const live = f.engine.s.extraValidations![0]!;
            const pid = live.clientPid!;
            const start = "Fri Oct 23 08:00:00 2026";
            const owned = `${pid} ${pid} S ${start} docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image\n`;
            const listing = processTree.processList;
            let clientReads = 0;
            const read = spyOn(processTree, "processList").mockImplementation(async (...args: Parameters<typeof listing>) => {
              if (!args[0].includes("pid=,pgid=,stat=,lstart=,command=")) return listing(...args);
              clientReads++;
              return evidence === "reused number"
                ? `${pid} ${pid} S ${start} unrelated-program\n`
                : evidence === "unreadable list"
                  ? undefined
                  : evidence === "list lost after stopping"
                    ? clientReads % 2
                      ? owned
                      : undefined
                    : owned;
            });
            owner.onStop(() => read.mockRestore());
            const signal = process.kill;
            const kill = spyOn(process, "kill").mockImplementation(((target: number, how?: NodeJS.Signals | number) => {
              if (target === -pid) {
                if (evidence === "owned client") {
                  throw Object.assign(new Error("Controlled client stop refusal"), { code: "EPERM" });
                }
                return true;
              }
              return signal(target, how);
            }) as typeof process.kill);
            owner.onStop(() => kill.mockRestore());
            const productTask = await f.add();
            productTask.state = "running";
            const controller = new AbortController();
            owner.onStop(() => controller.abort());
            let productRun: Promise<unknown> | undefined;
            try {
              f.release(record);
              await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "cleanup to stay unconfirmed");
              const detail = f.engine.s.extraValidations![0]!.cleanupDetail!;
              if (evidence === "reused number") {
                expect(detail).toContain("may be unrelated");
                expect(detail).toContain("Do not stop programs based on the saved number");
                expect(detail).not.toContain("Stop those owned programs");
                expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
              } else if (evidence === "owned client") {
                expect(detail).toContain(
                  "verified local client for extra validation “Required Linux suite” and its helpers are still running. Stop that named client",
                );
              } else {
                expect(detail).toBe(
                  "Petrina could not inspect the local client programs. Restore process-list access so Petrina can confirm they stopped.",
                );
                expect(detail).not.toContain("Stop");
              }
              productRun = f.engine["checks"]
                .runProductChecks(
                  executionFor(productTask),
                  [{ name: "Ordinary check", argv: [process.execPath, "-e", "process.exit(0)"] }],
                  controller.signal,
                )
                .then(
                  (result) => ({ failures: nonpassingChecks(result) }),
                  (error: unknown) => ({ error }),
                );
              owner.onStop(async () => {
                await Promise.allSettled(productRun ? [productRun] : []);
              });
              await waitFor(() => productTask.checkActivity?.phase === "held", "the product check to wait on held cleanup");
              expect(f.engine.checkQueue.running).toBe(1);
              expect(productTask.statusLine).toBe("Waiting for checks · held for cleanup");
              expect(productTask.checkActivity!.holds).toEqual([
                {
                  kind: "cleanup",
                  owner: { taskId: f.task.id, title: f.task.title, kind: "extra", name: "Required Linux suite" },
                  detail,
                },
              ]);
              const text = checkHoldLine(productTask.checkActivity!.holds![0]!, f.engine.s.tasks);
              expect(text).toBe(f.engine.extraValidations.blocker!);
              const health = await f.coordination.call("task.health", { taskId: productTask.id });
              expect(health).toMatchObject({
                waitingReason: "Waiting for checks · held for cleanup",
                checks: { phase: "held", holds: [{ kind: "cleanup", validation: "Required Linux suite", detail, text }] },
              });
              expect((await f.coordination.call("task.inspect", { taskId: productTask.id })).task).toMatchObject({
                waitKind: "checks",
                checks: { holds: [{ text }] },
              });
              await f.engine.extraValidations.retryCleanup();
              expect(f.engine.checkQueue.running).toBe(1);
              expect(productTask.checkActivity?.phase).toBe("held");
              read.mockRestore();
              kill.mockRestore();
              await f.engine.extraValidations.retryCleanup();
              expect((await f.finished(record)).result).toBe("passed");
              expect(await productRun).toEqual({ failures: 0 });
              expect(productTask.checkActivity).toBeUndefined();
            } finally {
              read.mockRestore();
              kill.mockRestore();
              controller.abort();
              await Promise.allSettled(productRun ? [productRun] : []);
              await owner.stop(f.engine);
            }
          },
          { runCheckCommand: runQuickOrdinaryCheck },
          { fastClientStop: false, actorLease: false },
        ),
      ));
  }

  it("names restart recovery as a hold on new work, never a paused pool, then lets the checks run", () =>
    cases.use("petrina-extra-", async (owner) =>
      fastExtraFixture(owner, async (f) => {
        const record = await f.submit("recovery-hold", ["probe", "pass"]);
        const saved = f.engine.s.extraValidations![0]!;
        saved.state = "stopping";
        saved.startedAt = Date.now();
        saved.stoppingAt = Date.now();
        const productTask = await f.add();
        f.engine.s.pool.paused = false;
        f.engine.commitNow();
        await owner.stop(f.engine);
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        owner.onStop(() => released.resolve());
        const cleanup = spyOn(ExtraContainer.prototype, "cleanup").mockImplementation(async () => {
          entered.resolve();
          await released.promise;
          return true;
        });
        owner.onStop(() => cleanup.mockRestore());
        const replacement = owner.open(f.data, f.settings);
        replacement.schedule = () => {
          replacement.extraValidations.pump();
          replacement.checkQueue.pump();
        };
        const current = replacement.task(productTask.id)!;
        current.state = "running";
        const run = () =>
          replacement["checks"].runProductChecks(
            executionFor(current),
            [{ name: "Ordinary check", argv: [process.execPath, "-e", "process.exit(0)"] }],
            new AbortController().signal,
          );
        try {
          await entered.promise;
          expect(replacement.extraRecovery).toBe(true);
          expect(replacement.s.pool.paused).toBe(false);
          const refused = await rejectionOf(run());
          expect(refused).toBeInstanceOf(WaitingForUsage);
          expect((refused as WaitingForUsage).words).toBe("Waiting while Petrina confirms an earlier validation stopped");
          expect(replacement.taskAdmissionWait(current)).toBe("Waiting while Petrina confirms an earlier validation stopped");
          expect(current.checkActivity).toBeUndefined();
          replacement.s.pool.paused = true;
          expect(replacement.taskAdmissionWait(current)).toBe("Waiting for the pool to resume");
          replacement.s.pool.paused = false;
          released.resolve();
          await replacement.extraValidations.ready;
          expect(replacement.extraValidations.get(record.requestId)!.outcome).toBe("completed");
          expect(nonpassingChecks(await run())).toBe(0);
          expect(current.checkActivity).toBeUndefined();
        } finally {
          released.resolve();
          cleanup.mockRestore();
          await owner.stop(replacement);
        }
      }),
    ));
});
