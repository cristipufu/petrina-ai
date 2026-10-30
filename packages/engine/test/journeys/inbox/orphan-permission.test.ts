import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { fakeAgentSessions } from "../../fixtures/fake-agent-sessions.js";
import { installPreparedProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { FAKE_AGENT, Fakes, makeProduct, SLOW } from "../../fixtures.js";
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { join } from "node:path";
import { type State } from "@petrina/core";
import { Engine } from "../../engine.js";

const fake = FAKE_AGENT;

async function makeRepo(owner: EngineCaseOwner, name: string): Promise<string> {
  return owner.prepare(async () => {
    const repo = await makeProduct(join(owner.root, name), { origin: "none" }); owner.check();
    return repo;
  });
}

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

/** Wait for a condition on the engine's state, answering the inbox like a coordinator would. */
async function until(engine: Engine, done: (state: State) => boolean, respond: (engine: Engine, state: State) => void, ms = 60_000): Promise<State> {
  const started = Date.now();
  for (;;) {
    const state = engine.getState();
    if (done(state)) return state;
    if (Date.now() - started > ms * SLOW) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))} Inbox: ${JSON.stringify(state.inbox.map((item) => item.kind))}`);
    respond(engine, state);
    await Bun.sleep(50);
  }
}

describe("answers to a request missing from the inbox", () => {
  it("resumes its live waiter without an extra agent turn, and keeps other open permissions blocking", async () => {
    return engineCases.use("petrina-engine-", async caseOwner => {
    const temp = caseOwner.root;
    const fakes = new Fakes(join(temp, "fake"));
    const engine = installSharedWorkflowFastPaths(
      caseOwner.open(join(temp, "orphan-data"), { agentCommand: () => [process.execPath, fake, fakes.dir], startAgentSession: fakeAgentSessions(fakes), toolProbe: privateAgentToolProbe() }),
      { skipDriverPrepare: true, skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true },
    );
    try {
      const repo = await makeRepo(caseOwner, "orphan-repo");
      await engine.waitUntilReady(); caseOwner.check(); engine.stopRequested.signal.throwIfAborted();
      const productId = installPreparedProduct(engine, { id: "orphan-repo", name: "Orphan Repo", repo: "local/orphan-repo", path: repo,
        defaultBranch: "main", tone: "blue", delivery: "local", approveDelivery: true });
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file.", kind: "feature" });
      const state = await until(engine, (s) => s.inbox.some((item) => item.taskId === taskId && item.kind === "permission"), (current, snapshot) => {
        for (const item of snapshot.inbox) {
          if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "plan" || item.kind === "design") current.approve(item.id);
        }
      });
      const permission = state.inbox.find((item) => item.taskId === taskId && item.kind === "permission")!;
      // A second permission may be open while another member of a review team asks.
      const livePermission = engine.s.inbox.find((item) => item.id === permission.id)!;
      engine.s.inbox.push({ ...livePermission, id: "another-permission" });
      engine.allow("another-permission", "once");
      expect(engine.getState().tasks.find((t) => t.id === taskId)!.state).toBe("needs-you");
      expect(engine.getState().inbox.some((item) => item.id === permission.id)).toBe(true);
      // Reproduce state saved by an older version after a wrong inbox action consumed the item.
      engine.s.inbox = engine.s.inbox.filter((item) => item.id !== permission.id);
      engine.answer(permission.id, "allow", { taskId, about: permission.title });
      const recovered = engine.getState().tasks.find((t) => t.id === taskId)!;
      expect(recovered.state).toBe("running");
      expect(recovered.statusLine).toBe("Back to work");
      expect(recovered.queued).toEqual([]);
      const final = await until(engine, (s) => s.tasks.find((t) => t.id === taskId)?.state === "done", (current, snapshot) => {
        for (const item of snapshot.inbox) {
          if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") current.allow(item.id, "once");
          else current.approve(item.id);
        }
      });
      expect(final.tasks.find((t) => t.id === taskId)!.timeline.some((entry) => entry.text === "You answered: allow")).toBe(true);
      expect(readFileSync(join(repo, "greeting.txt"), "utf8").replace(/\r?\n$/, "")).toBe("Hello (with left-pad)");
    } finally {
      await caseOwner.stop(engine);
    }
    });
  });
});
