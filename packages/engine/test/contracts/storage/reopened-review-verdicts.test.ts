import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { reviewStats } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Store } from "@petrina/storage/store";
import { waitFor } from "../../fixtures.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, lines, close } = reviewJourneyFixtures();
afterAll(close);
describe.concurrent("reviews that converge", () => {
it("rechecks a dismissed finding against fresh proof without counting its historical raiser as current support", async () => {
    const run = await untilDelivery({ reviewer: "important", verifier: "not-a-bug", builder: "plain" });
    const old = run.task.findings.find((finding) => finding.severity === "blocking")!;
    expect(old.status).toBe("dismissed");
    expect(old.verification?.verdict).toBe("not-a-bug");
    const stageIndex = run.task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
    const stage = run.task.plan!.stages[stageIndex]!;
    const data = join(run.root, "data");
    const store = new Store(join(data, "petrina.db"));
    try {
      const state = store.load()!;
      store.save({ ...state, inbox: [], tasks: state.tasks.map((task) => task.id !== run.task.id ? task : { ...task, state: "waiting", stageIndex, sub: 0, rounds: { ...task.rounds, [stage.id]: 2 }, hunt: undefined }) });
    } finally { store.close(); }
    const evidence = "On current code, the guest greeting disappears after signing out; signed-in visitors still see it. Expected both states to retain the greeting.";
    run.fakes.scenario({ builder: "plain", reviewer: "confirm-dismissed", reopenedEvidence: evidence, verifier: "real" });
    const engine = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), run.fakes.dir] });
    try {
      const task = await waitFor(() => {
        const state = engine.getState();
        const task = state.tasks.find((entry) => entry.id === run.task.id)!;
        if (task.state === "failed") throw new Error(task.error);
        return state.inbox.some((item) => item.taskId === task.id && item.kind === "delivery") && task;
      }, "new proof of the dismissed finding to receive a fresh ballot");
      const reopened = task.findings.find((finding) => finding.id === old.id)!;
      expect(reopened.status).toBe("open");
      expect(reopened.evidence).toBe(evidence);
      expect(reopened.confirmedBy).toEqual([stage.profileIds[1]!]);
      expect(reopened.verification?.verdict).toBe("real");
      expect(reopened.votes).toHaveLength(run.voters);
      expect(old.votes).toHaveLength(run.nonblocking);
      expect(reopened.earlierReviews).toHaveLength(1);
      expect(reopened.earlierReviews![0]!.evidence).toBe(old.evidence);
      expect(reopened.earlierReviews![0]!.verification?.verdict).toBe("not-a-bug");
      expect(reopened.earlierReviews![0]!.votes).toEqual(old.votes);
      expect(run.fakes.openings("verifier")).toHaveLength(run.nonblocking + run.voters);
      const corrections = run.fakes.received("code reviewer").filter((entry) => entry.text.startsWith("Your result block could not be used: Current evidence is required"));
      expect(corrections).toHaveLength(1);
      expect(run.fakes.received("code reviewer").find((entry) => entry.session === corrections[0]!.session)!.text).toContain("(dismissed)");
      expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
    } finally { await engine.shutdown(); }
    const restored = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), run.fakes.dir] });
    try {
      const saved = restored.task(run.task.id)!.findings.find((finding) => finding.id === old.id)!;
      expect(saved.status).toBe("open");
      expect(saved.evidence).toBe(evidence);
      expect(saved.verification?.verdict).toBe("real");
      expect(saved.earlierReviews![0]!.verification?.verdict).toBe("not-a-bug");
      expect(saved.earlierReviews![0]!.votes).toEqual(old.votes?.map((vote) => ({ ...vote })));
      expect(run.fakes.openings("verifier")).toHaveLength(run.nonblocking + run.voters);
    } finally { await restored.shutdown(); }
  });

it("keeps an older saved verified fix after a new ballot rejects its reopening", async () => {
    const run = await untilDelivery({ reviewer: "important" });
    const data = join(run.root, "data");
    const store = new Store(join(data, "petrina.db"));
    const stageIndex = run.task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
    const stage = run.task.plan!.stages[stageIndex]!;
    try {
      const state = store.load()!;
      store.save({ ...state, inbox: [], tasks: state.tasks.map((task) => task.id !== run.task.id ? task : {
        ...task, state: "waiting", stageIndex, sub: 0,
        hunt: { stageId: stage.id, round: 2, reported: { "0": true, "1": true }, findings: task.findings.length },
        findings: task.findings.map((finding) => finding.severity !== "blocking" ? finding : { ...finding, status: "open", confirmedBy: [finding.raisedBy] }),
      }) });
    } finally { store.close(); }
    run.fakes.scenario({ builder: "plain", verifier: "not-a-bug" });
    const engine = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), run.fakes.dir] });
    try {
      const task = await waitFor(() => {
        const state = engine.getState();
        return state.inbox.some((item) => item.taskId === run.task.id && item.kind === "delivery") && state.tasks.find((task) => task.id === run.task.id);
      }, "the reopened saved finding to be verified again");
      const finding = task.findings.find((entry) => entry.severity === "blocking")!;
      expect(finding.status).toBe("fixed");
      expect(finding.verification?.verdict).toBe("not-a-bug");
      expect(finding.earlierReviews?.[0]?.verification?.verdict).toBe("real");
      expect(reviewStats([task]).findings).toMatchObject({ fixed: 2, notABug: 0 });
      expect(run.fakes.openings("builder")).toHaveLength(2);
    } finally { await engine.shutdown(); }
    const saved = new Store(join(data, "petrina.db"));
    try { expect(saved.load()!.tasks.find((task) => task.id === run.task.id)!.findings.find((finding) => finding.severity === "blocking")!.earlierReviews).toHaveLength(1); }
    finally { saved.close(); }
  });

});
