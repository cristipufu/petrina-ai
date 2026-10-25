import { describe as originalDescribe } from "bun:test";

import { expect, it, spyOn } from "bun:test";

import { beginAgentStep, openStep } from "@petrina/core";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { assignedCheckFailures, projectCheckEvidence, relatedCheckCandidates } from "../../../src/related-check-evidence.js";
import { executionFor } from "@petrina/orchestrator";
import { git, makeWorld, removeDir } from "../../support.js";

import { failureName, failure, peer } from "../../../../core/test/fixtures/related-check-evidence.js";

originalDescribe("related check evidence", () => {
it("records failure ownership and the completed Builder's answer, without borrowing a later pass after an update", async () => {
    const w = await makeWorld("related-recording");
    const engine = w.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    engine.schedule = () => {}; engine.setPoolPaused(false);
    const turn = spyOn(engine["turns"], "turn");
    try {
      const check = { name: "Tests", argv: [process.execPath, "-e", `if (!require('fs').existsSync('repair.txt')) { console.log(${JSON.stringify(`(fail) ${failureName} [5ms]`)}); process.exit(1); }`] };
      engine.s.products.push({ id: "p", name: "Product", repo: "acme/p", path: w.clone, tone: "blue", checksBy: "coordinator", checks: [check] });
      const id = engine.addTask({ productId: "p", title: "Repair the progress fixture", backlog: true });
      const task = engine.task(id)!; task.state = "running";
      const scope = executionFor(task);
      await git(w.clone, "checkout", "-qb", "repair");
      Object.assign(scope.work, { worktree: w.clone, baseSha: w.initial, base: "main", branch: "repair" });
      const stage = { id: "build", title: "Repair", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
      task.plan = { rationale: "Repair", plannerProfileId: "sol-high", stages: [stage] };
      engine["checks"].claimPreparation(id);
      const signal = new AbortController().signal;
      expect(await engine["checks"].runProductChecks(scope, [check], signal)).toBe(1);
      task.fixing = true;
      const failures = assignedCheckFailures(scope);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.check.namedFailures![0]!.name).toBe(failureName);
      const original = task.journey!.find((step) => step.id === failures[0]!.nodeId)!.productChecks![0]!;
      const originalReport = { result: original.result, output: original.run!.output };
      original.run!.interruption = { source: "macOS power log", at: Date.now(), event: "Entering Sleep state" };
      expect(assignedCheckFailures(scope)).toEqual([]);
      expect({ result: original.result, output: original.run!.output }).toEqual(originalReport);
      delete original.run!.interruption;
      expect(assignedCheckFailures(scope)).toHaveLength(1);
      const findingId = failures[0]!.check.findingId!;
      beginAgentStep(task, "builder", "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
      const value = { summary: "Repaired progress", changes: ["Wait for owned progress"], title: "Repair progress", answers: [{ id: findingId, fixed: true, text: "Wait for replacement-owned progress." }], learnings: [] };
      turn.mockImplementation(async () => {
        writeFileSync(join(w.clone, "repair.txt"), "replacement progress");
        openStep(task)!.agentResults = [{ roleId: "builder", profileId: "sol-high", at: Date.now(), value }];
        return value as never;
      });
      await engine["work"].runDo(scope, stage, signal);
      const candidate = task.journey!.findLast((step) => step.checkRepairs?.length)!.checkRepairs![0]!;
      expect(candidate.findingId).toBe(findingId);
      expect(candidate.failureNode).toBe(failures[0]!.nodeId);
      expect(candidate.answer.text).toBe(value.answers[0]!.text);
      expect(candidate.tree).toBe(await git(w.clone, "rev-parse", "HEAD^{tree}"));
      const candidateSha = await git(w.clone, "rev-parse", "HEAD");
      writeFileSync(join(w.clone, "update.txt"), "new base contents"); await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Update from main");
      engine["checks"].claimPreparation(id);
      expect(await engine["checks"].runProductChecks(scope, [check], signal)).toBe(0);
      expect(task.journey!.at(-1)!.checkAttempts![0]!.passed).toBe(true);
      expect(relatedCheckCandidates(failures, [projectCheckEvidence(task, "p")!], "p")[0]!.status).toBe("claimed");
      await git(w.clone, "reset", "--hard", candidateSha);
      engine["checks"].claimPreparation(id);
      expect(await engine["checks"].runProductChecks(scope, [check], signal)).toBe(0);
      expect(relatedCheckCandidates(failures, [projectCheckEvidence(task, "p")!], "p")[0]!.status).toBe("checked");
      expect(task.findings.find((finding) => finding.id === findingId)!.status).toBe("fixed");
      expect(scope.work.checkReturns).toBeUndefined();
      // Even an original exit-zero report cannot certify a repair when verification was interrupted.
      for (const ok of [false, true]) {
        const interrupted = { ...scope.work.checks!.results[0]!, ok, output: "Original reported result retained", interruption: { source: "macOS power log" as const, at: Date.now(), event: "Entering Sleep state" } };
        scope.work.checkReturns = 2;
        engine["checks"].claimPreparation(id);
        expect(await engine["checks"].runProductChecks(scope, [check], signal, [interrupted])).toBe(1);
        const recorded = task.journey!.at(-1)!;
        expect(recorded.checkAttempts![0]!.passed).not.toBe(true);
        expect(recorded.outcome).toBe("Interrupted — verification incomplete");
        expect(recorded.productChecks![0]!.run!.output).toBe(interrupted.output);
        expect(scope.work.checkReturns).toBe(2);
      }
    } finally { turn.mockRestore(); await engine.shutdown(); removeDir(w.dir); }
  });
});

originalDescribe("related check evidence", () => {
it("shows at most three compact leads to added Builder roles and keeps fresh and continued review blind", async () => {
    const w = await makeWorld("related-context");
    const engine = w.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    engine.setPoolPaused(true); engine.schedule = () => {};
    try {
      engine.s.products.push({ id: "p", name: "Product", repo: "acme/p", path: w.clone, tone: "blue", checksBy: "coordinator", checks: [{ name: "Types", argv: ["bun", "run", "typecheck"] }, { name: "Tests", argv: ["bun", "run", "test"] }] });
      const ownId = engine.addTask({ productId: "p", title: "Own repair", backlog: true });
      const task = engine.task(ownId)!; const scope = executionFor(task);
      const own = failure("j3");
      task.fixing = true; task.journey = [{ id: "j3", kind: "petrina", round: 1, sub: 0, startedAt: 1, endedAt: 2, end: "done", productChecks: [own.check], checkAttempts: [own.attempt] }];
      task.findings = [{ id: "f1", text: "Check failed: Tests (bun run test)", raisedBy: "petrina", confirmedBy: [], status: "open", severity: "blocking" }];
      scope.work.worktree = w.clone; scope.work.checks = { at: 2, provenance: { nodeId: "j3", attemptId: "run-0" }, results: [own.check.run] };
      for (let i = 0; i < 5; i++) {
        const id = engine.addTask({ productId: "p", title: "PRIVATE PEER REQUEST", backlog: true });
        const other = engine.task(id)!; other.state = "running";
        const p = peer(id); other.journey = p.journey.map((step) => ({ ...step, round: 1, sub: 0 }));
        executionFor(other).work.report = { summary: "PRIVATE FULL REPORT", changes: [] };
      }
      engine.s.roles.push({ ...engine.role("builder")!, id: "added-builder", name: "Repair builder" });
      const sections = await engine["context"].sectionsFor(scope, "added-builder");
      const section = sections.find((section) => section.title === "Related check evidence")!;
      expect(section.body.match(/Shared named failure:/g)).toHaveLength(3);
      expect(section.body).toContain("claimed for commit");
      expect(section.body).toContain("snapshot unavailable");
      expect(section.body).toContain("/missing-check.log");
      expect(section.body).not.toContain("PRIVATE");
      expect(section.body.length).toBeLessThan(6500);
      const review = await engine["context"].captureReview(scope);
      expect(JSON.stringify(review)).not.toContain("Related check evidence");
      for (const role of engine.s.roles.filter((role) => role.result !== "build")) {
        const fresh = await engine["context"].sectionsFor(scope, role.id);
        expect(fresh.some((section) => section.title === "Related check evidence")).toBe(false);
        const continued = await engine["context"].sectionsFor(scope, role.id, undefined, undefined, undefined, review);
        expect(continued.some((section) => section.title === "Related check evidence")).toBe(false);
      }
      const unavailable = spyOn(engine.store.history, "checkEvidence").mockImplementation(() => { throw new Error("History unavailable"); });
      try {
        const fallback = await engine["context"].sectionsFor(scope, "added-builder");
        expect(fallback.some((section) => section.title === "Related check evidence")).toBe(false);
        expect(fallback.some((section) => section.title.startsWith("Review findings"))).toBe(true);
      } finally { unavailable.mockRestore(); }
      const deliveredPeer = engine.s.tasks.find((other) => other.id !== task.id)!;
      deliveredPeer.state = "done";
      scope.work.baseSha = w.initial;
      await git(w.clone, "checkout", "-qb", "landed-lead");
      writeFileSync(join(w.clone, "landed-repair.txt"), "confirmed delivered contents");
      await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Deliver the related repair");
      const deliveredSha = await git(w.clone, "rev-parse", "HEAD"), deliveredTree = await git(w.clone, "rev-parse", "HEAD^{tree}");
      executionFor(deliveredPeer).work.confirmedDelivery = { sha: deliveredSha, tree: deliveredTree, repo: "acme/p", branch: "main", at: 10 };
      await git(w.clone, "checkout", "-q", "main");
      const missing = (await engine["context"].sectionsFor(scope, "added-builder")).find((section) => section.title === "Related check evidence")!.body;
      expect(missing).toContain("Separately confirmed landed contents");
      expect(missing).toContain(deliveredSha);
      expect(missing.indexOf(`Task ${deliveredPeer.id};`)).toBeLessThan(missing.indexOf(`Task ${engine.s.tasks[2]!.id};`));
      await git(w.clone, "merge", "--ff-only", "landed-lead");
      const included = (await engine["context"].sectionsFor(scope, "added-builder")).find((section) => section.title === "Related check evidence")!.body;
      expect(included).not.toContain(`Task ${deliveredPeer.id};`);
      expect(included).not.toContain("Separately confirmed landed contents");
      expect(scope.work.baseSha).toBe(w.initial);
      const initialTree = await git(w.clone, "rev-parse", `${w.initial}^{tree}`);
      for (let i = 0; i < 7; i++) {
        const id = engine.addTask({ productId: "p", title: "Already delivered peer", backlog: true });
        const other = engine.task(id)!; other.state = "done";
        other.journey = peer(id).journey.map((step) => ({ ...step, round: 1, sub: 0 }));
        executionFor(other).work.confirmedDelivery = { sha: w.initial, tree: initialTree, repo: "acme/p", branch: "main", at: 10 };
        // Seven and eight included deliveries must both leave room for active repairs.
        if (i < 5) continue;
        const remaining = (await engine["context"].sectionsFor(scope, "added-builder")).find((section) => section.title === "Related check evidence")!.body;
        expect(remaining.match(/Shared named failure:/g)).toHaveLength(3);
        expect(remaining).not.toContain("Separately confirmed landed contents");
        expect(remaining).not.toContain(`Task ${deliveredPeer.id};`);
        expect(remaining).not.toContain(`Task ${id};`);
      }
      task.fixing = false;
      expect((await engine["context"].sectionsFor(scope, "added-builder")).some((section) => section.title === "Related check evidence")).toBe(false);
      task.state = "cancelled";
      const actualSha = await git(w.clone, "rev-parse", "HEAD"), actualTree = await git(w.clone, "rev-parse", "HEAD^{tree}");
      scope.work.localUpdate = { branch: "main", sha: actualSha, pushed: false };
      await engine["shipping"]["recordLanded"](scope, "main", actualSha);
      expect(scope.work.confirmedDelivery).toBeUndefined();
      scope.work.localUpdate.pushed = true;
      await engine["shipping"]["recordLanded"](scope, "main", actualSha);
      expect(scope.work.confirmedDelivery).toEqual({ sha: actualSha, tree: actualTree, repo: "acme/p", branch: "main", at: expect.any(Number) });
      expect(scope.work.landed!.sha).toBe(actualSha.slice(0, 7));
    } finally { await engine.shutdown(); removeDir(w.dir); }
  });
});
