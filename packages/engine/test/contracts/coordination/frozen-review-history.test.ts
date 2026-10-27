import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { Coordination } from "../../../src/coordination.js";
import { readReviewInput } from "../../../src/review-context.js";
import { readReviewHistory } from "../../../src/review-history.js";
import { formatFindings } from "../../../src/prompts.js";
import { Cleanup } from "../../../src/cleanup.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { frozenHistoryFixtures } from "../../fixtures/review-history.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { sha, role, stage, fixture, freeze, longCard, supplied, measure } = frozenHistoryFixtures();
it("keeps complete full entries after completion, cleanup and restart; missing and changed files stay unavailable", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, 2);
    try {
      const cardId = f.engine.addTask({ productId: "p", title: longCard.title, description: longCard.problem, kind: "bug", backlog: true });
      const { input, ref, step } = await freeze(f);
      const originals = structuredClone(input.findings), originalCard = structuredClone(input.cards[0]!);
      const sections = await supplied(f, input);
      const full = step.reviewHistory!.body, historyFile = input.history!.file;
      step.agentInputs = [0, 1, 2].map(i => ({ at: 41, mode: "fresh", roleId: role.id, profileId: stage.profileIds[i]!, reviewerKey: String(i), taskTitle: f.task.title, reviewInput: ref, sections: sections.map(({ title, body }) => ({ title, body })) }));
      writeFileSync(historyFile, "CHANGED");
      await expectRejection(readReviewInput(ref), "frozen review history changed");
      writeFileSync(historyFile, full);
      f.task.findings[0]!.evidence = "LATER EDIT";
      f.task.findings[0]!.text = "LATER PROBLEM";
      f.engine.task(cardId)!.description = "LATER CARD";
      step.endedAt = 70; f.task.state = "done"; f.task.finishedAt = 80;
      f.engine.commitNow();
      await new Cleanup(f.engine).sweep();
      expect(existsSync(historyFile)).toBe(false); expect(existsSync(ref.file)).toBe(false);
      await owner.stop(f.engine);
      const restart = owner.open(f.data, { admissionsClosed: true, terminals: () => [] }); restart.schedule = () => {};
      try {
        const task = restart.task(f.task.id)!;
        const kept = task.journey!.find(s => s.id === step.id)!;
        expect(kept.reviewHistory!.body).toBe(full); expect(sha(full)).toBe(kept.reviewHistory!.digest);
        for (const seat of kept.agentInputs!) expect(JSON.stringify(seat.sections)).toContain(kept.reviewHistory!.digest);
        const c = new Coordination(restart);
        let page = await c.call("journey.review-input", { taskId: task.id, nodeId: step.id, section: "history", limit: 500 });
        let text = String(page.text);
        while (page.next) { page = await c.call("journey.review-input", { taskId: task.id, nodeId: step.id, section: "history", limit: 500, cursor: page.next }); text += page.text; }
        expect(text).toBe(full); expect(page.digest).toBe(kept.reviewHistory!.digest);
        const records = JSON.parse(text);
        expect(records.cards[cardId]).toEqual(originalCard);
        for (const original of originals) expect(records.findings[original.id]).toBe(formatFindings([original], { complete: true }));
        expect(text).toContain("Original vote for f0"); expect(text).toContain("Original evidence for f0"); expect(text).not.toContain("LATER");
        expect((await c.call("journey.review-input", { taskId: task.id, nodeId: step.id })).outcome).toBe("unavailable");
        await expectRejection(readReviewHistory(input.history!), "unavailable");
        measure("completion retained after cleanup and restart", f, sections, full);
      } finally { await owner.stop(restart); }
    } finally { await owner.stop(f.engine); }

  });
});
