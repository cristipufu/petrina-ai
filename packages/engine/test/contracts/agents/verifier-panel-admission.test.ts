import { afterAll, describe, expect, it } from "bun:test";
import { independentVotes } from "@petrina/core";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { voting, checkedFinding, plain, verifierSteps, inject, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("bounded verifier panels", () => {
it("starts two fresh verifiers instead of one per ready tool, avoiding the reporting tool", async () => {
    const f = await voting({}, 4, [], true);
    try {
      await f.run(async () => {
      // Keep actual near-limit admission in this transport control; usage permutations belong to selection contracts.
      f.engine.s.pool.usage = [{ toolId: "grok", kind: "five_hour", status: "allowed", utilization: 0.95, resetsAt: Date.now() + 3_600_000, at: Date.now() }];
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(new Set(independentVotes(finding.votes).map((vote) => vote.toolId))).toEqual(new Set(["codex", "grok"]));
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(finding.status).toBe("fixed");
      const steps = verifierSteps(f);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.seats).toEqual(["verifier:sol-high", "verifier:grok-high"]);
      expect(steps[0]!.agentInputs).toHaveLength(2);
      for (const input of steps[0]!.agentInputs!) expect(input.selectionReason).toContain("usable at selection: Claude Code, Codex, Grok and Antigravity; avoided Claude Code, which reported a finding");
      expect(f.task().timeline.some((entry) => entry.text.startsWith("Verifiers: ") && entry.text.includes("usable at selection: Claude Code, Codex, Grok and Antigravity"))).toBe(true);
      });
    } finally { await f.close(); }
  });



it("targets a mixed batch's third answer at the unsettled finding only", async () => {
    const f = await voting({ verifierByFinding: { second: { "gpt-6.1-sol": "nit", "grok-4.7": "nit", opus: "not-a-bug" } } }, 3, []);
    try {
      await f.run(async () => {
      inject(f, "second", "opus-high");
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const main = checkedFinding(f), second = f.task().findings.find((entry) => entry.id === "second")!;
      const openings = f.fakes.openings("verifier");
      expect(openings).toHaveLength(3);
      const thirdStep = verifierSteps(f)[1]!;
      expect(thirdStep.seats).toEqual(["verifier:third:opus-high"]);
      expect(thirdStep.agentInputs![0]!.selectionReason).toContain("Third answer: both first verifiers said this finding does not block");
      expect(f.task().timeline.some(entry => entry.step === thirdStep.id && entry.text === thirdStep.outcome)).toBe(true);
      const third = openings.find((text) => f.fakes.received("verifier").find((entry) => entry.text === text && f.model(entry.session) === "opus"))!;
      const ballot = third.slice(third.indexOf("## Important findings to check"));
      expect(ballot).toContain("- [second]");
      expect(ballot).not.toContain(`- [${main.id}]`);
      expect(plain(main.votes)!.map((vote) => vote.toolId).sort()).toEqual(["codex", "grok"]);
      expect(main.verification?.verdict).toBe("real");
      expect(second.verification?.verdict).toBe("nit");
      expect(second.severity).toBe("suggestion");
      expect(verifierSteps(f)[1]!.outcome).toBe("2 checked: 1 must be fixed in this change, 1 minor");
      });
    } finally { await f.close(); }
  });

it("leaves a finding unresolved when no ready tool can give its third answer, and never repeats that ballot", async () => {
    const f = await voting({ verifier: "not-a-bug", answer: { fixed: false, text: "It is not broken." }, reviewRounds: 2 }, 3, []);
    try {
      await f.run(async () => {
      await f.advance(() => f.fakes.received("verifier").length === 2, (role) => role !== "verifier");
      // Claude Code signs out after selection: it was usable, but cannot give the required third answer.
      f.engine.s.setup!.checks = [{ id: "claude-code", status: "logged-out" }, { id: "codex", status: "ready" }, { id: "grok", status: "ready" }];
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(finding.verification).toBeUndefined();
      expect(finding.unresolved?.reason).toContain("no ready independent tool can give the required third answer");
      // The reviewed commit and its tree, so a later round compares like with like.
      expect(Object.values(finding.unresolved?.heads ?? {})).toHaveLength(1);
      expect(Object.values(finding.unresolved?.trees ?? {})).toHaveLength(1);
      expect(finding.severity).toBe("blocking");
      expect(finding.status).toBe("open");
      expect(verifierSteps(f).map((step) => step.outcome)).toEqual(["1 checked: 1 unresolved"]);
      const { answer: laterAnswer, ...reviewed } = finding;
      expect(laterAnswer).toEqual({ fixed: false, text: "It is not broken.", at: expect.any(Number) });
      expect(verifierSteps(f)[0]!.result).toEqual({ findings: [reviewed], findingsSettled: true });
      expect(f.task().timeline.some((entry) => entry.text.startsWith("Review rounds used up"))).toBe(true);
      });
    } finally { await f.close(); }
  });



for (const modelOnly of [false, true]) it(`retains a selected seat whose ${modelOnly ? "model" : "tool"} is limited after its peer finishes, without borrowing the peer's vote`, async () => {
    // Grok is out before selection, so the pair is Codex and Claude Code with no independent replacement.
    const f = await voting({ limited: [{ model: "opus", role: "verifier", ...(modelOnly ? { type: "seven_day_opus" } : { spendCap: true }) }] }, 3, ["grok"]);
    try {
      await f.run(async () => {
      if (!modelOnly) {
        await f.advance(() => f.delivery() || (checkedFinding(f)?.votes?.length === 1 && f.task().state === "waiting" && f.fakes.received("verifier").length === 2));
        expect(f.delivery()).toBe(false);
        expect(checkedFinding(f).verification).toBeUndefined();
        expect(f.task().hunt?.panel?.seats.map((seat) => seat.toolId)).toEqual(["codex", "claude-code"]);
        expect(f.task().hunt?.panel?.usable).toEqual(["claude-code", "codex"]);
        const accepted = structuredClone(checkedFinding(f).votes!);
        await f.restart();
        expect(checkedFinding(f).votes).toEqual(accepted);
        expect(checkedFinding(f).verification).toBeUndefined();
        f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important" });
        for (const limit of f.engine.s.pool.limited ?? []) if (limit.toolId === "claude-code") limit.until = Date.now() - 1;
        for (const report of f.engine.s.pool.usage ?? []) if (report.toolId === "claude-code") report.resetsAt = Date.now() - 1;
        f.engine.schedule();
      }
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      const finished = f.engine.tracking.log.turns({ taskId: f.task().id }).filter((turn) => turn.roleId === "verifier" && turn.end === "finished");
      expect(finished).toHaveLength(2);
      expect(new Set(finished.map((turn) => turn.toolId)).size).toBe(finished.length);
      expect(finding.votes).toHaveLength(finished.length);
      expect(finding.votes?.some((vote) => vote.by === "opus-high")).toBe(!modelOnly);
      if (modelOnly) expect(finding.votes?.find((vote) => vote.toolId === "claude-code")?.by).toBe("sonnet-high");
      expect(finding.verification?.verdict).toBe("real");
      });
    } finally { await f.close(); }
  });

it("replaces a selected seat limited after its peer finishes with an independent usable tool", async () => {
    const f = await voting({ limited: [{ model: "grok-4.7", role: "verifier", spendCap: true }] }, 3, []);
    try {
      await f.run(async () => {
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(new Set(plain(finding.votes)!.map((vote) => vote.toolId))).toEqual(new Set(["codex", "claude-code"]));
      expect(finding.votes!.find((vote) => vote.toolId === "claude-code")!.ballot!.seat).toBe("grok-high");
      const replacement = f.task().journey!.flatMap((step) => step.agentInputs ?? []).find((input) => input.selectionReason?.includes("takes its required seat"));
      expect(replacement?.profileId).toBe("opus-high");
      expect(finding.verification?.verdict).toBe("real");
      });
    } finally { await f.close(); }
  });



});
