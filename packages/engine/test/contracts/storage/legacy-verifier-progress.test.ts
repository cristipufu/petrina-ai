import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type Task } from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { reviewProgressFixtures } from "../../fixtures/review-todo.js";

const { setup, close } = reviewProgressFixtures();
afterAll(close);
describe("real grouped review summaries", () => {
  for (const savedBy of ["opus-high", "sol-high"]) {
    it(`keeps an older vote credited to ${savedBy} when the remaining voter finishes after a restart`, async () => {
      const run = await setup("code-reviewer", true);
      return run.use(async () => {
        const owners = run.owners;

        let engine = run.engine;
        const savedVote = { by: savedBy, verdict: "real" as const, reason: "The greeting is missing." };
        try {
          await owners.run(engine, async () => engine.act("setPoolPaused", true));
          await run.approve();
          await engine.quit();
          // The previous engine saved the replacement's actual profile, without a planned slot.
          // Older planned attribution also remains valid, without guessing who actually ran it.
          const store = new Store(join(run.home, "petrina.db"));
          try {
            const state = store.load()!;
            store.save({
              ...state,
              tasks: state.tasks.map((task): Task => task.id !== run.taskId ? task : {
                ...task,
                stageIndex: task.plan!.stages.findIndex((stage) => stage.id === run.stage.id),
                hunt: { stageId: run.stage.id, round: 1, reported: { "0": true, "1": true }, voted: { "sol-high": true }, findings: 0 },
                findings: [{ id: "saved-finding", text: "The greeting is missing.", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "open", votes: [savedVote] }],
              }),
            });
          } finally { store.close(); }
          run.fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true });
          engine = await run.launch();
          expect(run.find(await owners.run(engine, async () => engine.state())).hunt?.voterProfiles).toBeUndefined();
          await owners.run(engine, async () => engine.act("setPoolPaused", false));
          const reserved = await owners.run(engine, async () => engine.until((state) => {
            // An older vote without a tool does not fill a seat, so a full fresh pair still votes.
            const count = state.tools.filter((tool) => tool.status === "ready").length;
            const seats = Object.keys(run.find(state).hunt?.work ?? {}).filter((key) => key.startsWith("verifier:")).length;
            return count > 0 && seats === Math.min(2, count);
          }, "the remaining voters' seats"));
          const tags = [run.find(reserved).agent!, ...(run.find(reserved).helpers ?? [])].map((agent) => {
            const profile = reserved.profiles.find((profile) => profile.id === agent.profileId)!;
            return `verifier-${profile.modelId}-${profile.effort}`;
          });
          await Promise.all(tags.map((tag) => run.ready(tag)));
          for (const tag of tags) for (const name of ["publish-1", "action-1", "result-1", "finish"]) run.go(`${name}-${tag}`);
          const voted = run.find(await owners.run(engine, async () => engine.until((state) => !!run.find(state).findings[0]?.verification, "the saved finding's verdict")));
          const finding = voted.findings[0]!;
          expect(finding.votes).toHaveLength(1 + tags.length);
          expect(finding.votes![0]).toEqual(savedVote);
          expect(finding.votes!.some((vote) => vote.by === "opus-high" && vote.plannedProfileId === "opus-high")).toBe(true);
          expect(finding.votes!.slice(1).every((vote) => vote.plannedProfileId && vote.verdict === "real")).toBe(true);
          expect(finding.verification!.verdict).toBe("real");
          expect(finding.status).not.toBe("dismissed");
          await engine.quit();
          const saved = new Store(join(run.home, "petrina.db"));
          try { expect(run.find(saved.load()!).findings[0]!.votes).toEqual(finding.votes); } finally { saved.close(); }
        } finally { if (engine.proc.exitCode === null) await engine.quit(); }

      });
    });
  }

});
