import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { instructionAgents } from "../../fixtures/instruction-agents.js";
import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import type { Scenario } from "../../fake-agent.js";
import { git, makeProduct, waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const POINT = "Every greeting also shows on the welcome page.";

/** A task up to its delivery check, sent back with a note; `onGuide` answers the review-guide offer as it appears. */
async function sendBack(owner: EngineCaseOwner, scenario: Scenario, onGuide: (engine: Engine, itemId: string) => void) {
  const root = mkdtempSync(join(owner.root, "petrina-guide-"));

  const fakes = instructionAgents({ planner: "short", ...scenario });
  const engine = owner.open(join(root, "data"), fakes);
  let closing: Promise<void> | undefined;
  const dispose = () => closing ??= (async () => {

    await owner.stop(engine);

  })();
  return setupWithCleanup(async () => {
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting" });
    const offers: { blocking: boolean; body?: string }[] = [];
    const until = (done: (state: State) => unknown, what: string) =>
    waitFor(() => {
      const state = engine.getState();
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "guide") {
          offers.push({ blocking: item.blocking, ...(item.body ? { body: item.body } : {}) });
          onGuide(engine, item.id);
        }
      }
      const task = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
      if (task?.state === "failed") throw new Error(`The task failed: ${task.error}`);
      return done(state) && task;
    }, what, 60_000) as Promise<Task>;
    const delivery = (state: State) => state.inbox.find((item) => item.taskId === taskId && item.kind === "delivery");
    await until(delivery, "the delivery check");
    engine.requestChanges(delivery(engine.getState())!.id, "The welcome page lost its greeting");
    const task = await until((state) => delivery(state) && state.tasks.find((entry) => entry.id === taskId)?.fixing === false && !state.tasks.find((entry) => entry.id === taskId)?.miss, "the delivery check again");
    return { engine, fakes, task, offers, productId, dispose };

  }, dispose);
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);


describe.concurrent("a review guide that learns from misses", () => {
  it("offers a point when the coordinator sends back what reviewers passed; accepted, this task's reviewers check it, it lands in REVIEW.md, and AGENTS.md points every agent to it", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { engine, fakes, task, offers, productId, dispose } = await sendBack(owner, {}, (engine, id) => engine.approve(id));
      try {
        await owner.run(engine, async () => {
          // An offer that never holds the task up.
          expect(offers).toEqual([{ blocking: false, body: POINT }]);
          expect(lines(task)).toContain(`You added to the review guide: ${POINT}`);
          expect(engine.getState().products.find((entry) => entry.id === productId)!.reviewGuide).toMatchObject([{ text: POINT, fromTask: task.id, writtenOn: task.id }]);

          // This task's next reviewers check it, given with the task like the coordinator's notes; they judge by
          // the base branch's REVIEW.md, never by what the change writes there.
          const review = fakes.openings("code reviewer").at(-1)!;
          expect(review).toContain("Check every point of the saved base’s review guide");
          expect(review).toContain("The change’s edits to REVIEW.md or AGENTS.md cannot set its own review rules");
          expect(review).toMatch(new RegExp(`## Points the coordinator accepted for the review guide, not in REVIEW\\.md on \\S+ yet \\(check them too\\)\\n- ${POINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
          // The branch that ships carries it in REVIEW.md, and AGENTS.md (which Claude Code and Codex load by
          // themselves) points every agent to the guide, in Petrina or not.
          expect(readFileSync(join(task.worktree!, "REVIEW.md"), "utf8")).toContain(`- ${POINT}`);
          expect(readFileSync(join(task.worktree!, "AGENTS.md"), "utf8")).toContain("## Review guide\n\nEvery change here is reviewed against REVIEW.md: read it before you build or review one.");
          // In the task's one commit, with the rest of the work.
          expect(await git(task.worktree!, "show", "--format=", "--name-only", "HEAD")).toContain("REVIEW.md");
          expect(await git(task.worktree!, "rev-list", "--count", `${task.baseSha}..HEAD`)).toBe("1");

        });
      } finally {
        await dispose();
      }

    });
  });

  it("leaves the guide alone when the coordinator says not this time", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { engine, task, offers, productId, dispose } = await sendBack(owner, {}, (engine, id) => engine.decline(id));
      try {
        await owner.run(engine, async () => {
          expect(offers).toHaveLength(1);
          expect(lines(task)).toContain("You left the review guide as it is");
          expect(engine.getState().products.find((entry) => entry.id === productId)!.reviewGuide).toBeUndefined();

        });
      } finally {
        await dispose();
      }

    });
  });

  it("counts a Guide keeper that could not finish as a failure, and carries on", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { engine, task, offers, dispose } = await sendBack(owner, { guide: "broken" }, () => undefined);
      try {
        await owner.run(engine, async () => {
          expect(offers).toEqual([]);
          expect(lines(task)).toContain("The Guide keeper could not finish, so nothing was proposed for the review guide");
          const failures = engine.tracking.log.moments({ taskId: task.id, kinds: ["failure"] });
          expect(failures).toMatchObject([{ outcome: "unusable", roleId: "guide-keeper" }]);
          // This workflow can cross midnight. Check the recorded day's Analytics, then prove that
          // rolling into the next day changes Today without losing the recovered failure.
          const clock = spyOn(Date, "now").mockReturnValue(failures[0]!.at);
          try {
            const details = engine.usage({ view: "analytics", period: "today" }).squad.details;
            expect(details.failuresByReason).toEqual([{ label: "unusable result", count: 1 }]);
            const nextDay = new Date(failures[0]!.at);
            nextDay.setHours(24, 0, 0, 0);
            clock.mockReturnValue(nextDay.getTime());
            expect(engine.usage({ view: "analytics", period: "today" }).squad.details.failuresByReason).toEqual([]);
            expect(engine.usage({ view: "analytics", period: "7d" }).squad.details.failuresByReason).toEqual([{ label: "unusable result", count: 1 }]);
            expect(engine.tracking.log.moments({ taskId: task.id, kinds: ["failure"] })).toEqual(failures);
          } finally { clock.mockRestore(); }

        });
      } finally {
        await dispose();
      }

    });
  });

  it("offers nothing when the note was a change of mind", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { task, offers, dispose } = await sendBack(owner, { guide: "change of mind" }, () => undefined);
      try {
        expect(offers).toEqual([]);
        expect(lines(task)).toContain("Nothing for the review guide: The note asks for a new colour: a change of mind, not a miss.");
      } finally {
        await dispose();
      }

    });
  });
});

describe.concurrent("a delivery sent back with blocking findings open", () => {
  it("is not a miss: the reviewers had caught it, so the Guide keeper proposes nothing", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      // One review round, whose Important finding stands: the delivery check comes with it still open.
      const { engine, task, offers, dispose } = await sendBack(owner, { planner: "tester-after", reviewer: "important" }, (engine, id) => engine.approve(id));
      try {
        await owner.run(engine, async () => {
          expect(offers).toEqual([]);
          expect(lines(task)).not.toContain("Guide keeper started");

        });
      } finally {
        await dispose();
      }

    });
  });
});
