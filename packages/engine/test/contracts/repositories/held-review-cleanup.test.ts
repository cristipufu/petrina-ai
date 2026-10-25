import { afterAll, describe, expect, it } from "bun:test";
import { dirname, sep } from "node:path";
import { git } from "../../fixtures.js";
import { FixtureTrace } from "../../fixture-trace.js";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
it("records held copy cleanup after both reviewers return, then preserves their handoff", async () => {
    const lines: string[] = [];
    const trace = new FixtureTrace("Held review cleanup", (line) => lines.push(line));
    const f = await fixture(true, "code-reviewer", trace).catch((error) => { trace.close(); throw error; });
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const pruned = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>();
    const during = trace.during.bind(trace);
    trace.during = <T>(phase: string, work: () => Promise<T>) => during(phase, async () => {
      if (phase.startsWith("Removing review copies:") && Object.keys(f.task.hunt?.reported ?? {}).length === 2) {
        held.resolve();
        await release.promise;
      }
      return work();
    });
    const duringProcess = trace.duringProcess.bind(trace);
    trace.duringProcess = <T>(phase: string, work: Parameters<typeof trace.duringProcess<T>>[1]) => duringProcess(phase, async (capture) => {
      const result = await work(capture);
      if (phase.endsWith(": git worktree prune") && Object.keys(f.task.hunt?.reported ?? {}).length === 2) {
        pruned.resolve();
        await releaseResult.promise;
      }
      return result;
    });
    const round = f.round(1);
    try {
      await Promise.race([held.promise, round.then(() => { throw new Error("The review finished without observing copy cleanup"); })]);
      trace.report("still waiting");
      const evidence = JSON.parse(lines.at(-1)!.split("Held review cleanup: ")[1]!);
      expect(evidence.pending.some((entry: { phase: string }) => entry.phase.includes("Removing review copies:"))).toBe(true);
      expect(evidence.details.root).toBe(dirname(f.engine.dataDir));
      expect(evidence.progress.some((entry: { phase: string }) => entry.phase === "Waiting for yielded reviewer processes: complete")).toBe(true);
      expect(evidence.details.hunt.reported).toEqual({ "0": true, "1": true });
      expect(evidence.details.ownedWork.runs).toEqual([]);
      release.resolve();
      await Promise.race([pruned.promise, round.then(() => { throw new Error("The review finished without observing Git pruning"); })]);
      trace.report("still waiting");
      const afterExit = JSON.parse(lines.at(-1)!.split("Held review cleanup: ")[1]!);
      // The primary-copy status check runs beside pruning and may still be pending too.
      const pruning = afterExit.processes.filter((entry: { phase: string }) => entry.phase.endsWith(": git worktree prune"));
      expect(pruning).toHaveLength(1);
      expect(pruning[0]).toEqual(expect.objectContaining({
        phase: expect.stringContaining(": git worktree prune"), pid: expect.any(Number), exitWait: "completed", exitCode: 0, signalCode: null, hasExited: true,
      }));
      expect(afterExit.processes.every((entry: { phase: string }) => entry.phase.startsWith(`Git in ${dirname(f.engine.dataDir)}${sep}`))).toBe(true);
      expect(afterExit.pending.some((entry: { phase: string }) => entry.phase.endsWith(": git worktree prune"))).toBe(true);
      releaseResult.resolve();
      expect(await round).toHaveLength(2);
      expect(Object.keys(f.task.reviewSessions![f.stage.id]!)).toEqual(["0", "1"]);
      expect(await git(f.scope.work.worktree!, "worktree", "list", "--porcelain")).not.toContain("task-1.copies");
      trace.report("complete");
      expect(JSON.parse(lines.at(-1)!.split("Held review cleanup: ")[1]!).processes).toEqual([]);
    } finally {
      release.resolve();
      releaseResult.resolve();
      try { await round; }
      finally { try { await f.engine.shutdown(); } finally { f.closeTrace(); } }
    }
  });

});
