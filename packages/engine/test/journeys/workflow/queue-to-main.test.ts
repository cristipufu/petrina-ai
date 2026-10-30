import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { readRef } from "../../fixtures/shared-preparation.js";
import { createProductRepository, FAKE_AGENT, SLOW } from "../../fixtures.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, renameSync } from "node:fs";

import { join } from "node:path";
import { type State } from "@petrina/core";
import { Engine } from "../../engine.js";

const fake = FAKE_AGENT;

async function makeRepo(temp: string, name = "repo"): Promise<string> {
  const { path: clone } = await createProductRepository(join(temp, `${name}-seed`), { origin: "none" });
  const repo = join(temp, name);
  renameSync(clone, repo);
  return repo;
}

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

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

describe("Engine with a fake ACP agent", () => {
  it("takes a task from the queue to a commit on main, asking the coordinator along the way", async () => {
    return engineCases.use("petrina-engine-", async caseOwner => {
    const temp = caseOwner.root, repo = await makeRepo(temp);
    const awakeChanges: boolean[] = [];
    const engine = caseOwner.open(join(temp, "data"), { agentCommand: () => [process.execPath, fake], toolProbe: privateAgentToolProbe(), awakeObserver: (active) => awakeChanges.push(active) });
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A friendly greeting file.", kind: "feature" });

    const asked = new Set<string>();
    const state = await until(
      engine,
      (current) => ["done", "failed"].includes(current.tasks.find((task) => task.id === taskId)?.state ?? ""),
      (current, snapshot) => {
        for (const item of snapshot.inbox) {
          if (asked.has(item.id)) continue;
          asked.add(item.id);
          if (item.kind === "question") {
            expect(() => current.approve(item.id)).toThrow("question");
            expect(() => current.allow(item.id, "once")).toThrow("permission");
            expect(current.getState().inbox.some((entry) => entry.id === item.id)).toBe(true);
            current.answer(item.id, item.options?.[0] ?? "Yes");
          }
          else if (item.kind === "permission") {
            expect(() => current.approve(item.id)).toThrow("permission");
            expect(current.getState().inbox.some((entry) => entry.id === item.id)).toBe(true);
            current.allow(item.id, "once");
          }
          else current.approve(item.id);
        }
      },
    );

    const task = state.tasks.find((entry) => entry.id === taskId)!;
    expect(task.error).toBeUndefined();
    expect(task.state).toBe("done");
    expect(awakeChanges[0]).toBe(true);
    expect(task.landed?.branch).toBe("main");
    // The coordinator was asked a question, a permission and two checkpoints.
    expect(task.timeline.some((entry) => entry.text.startsWith("You answered: Formal"))).toBe(true);
    // The tool's own safety check asked; Petrina passed it on unchanged.
    expect(task.timeline.some((entry) => entry.text.includes("You allowed: Installing packages"))).toBe(true);
    expect(task.timeline.some((entry) => entry.text === "You approved the design")).toBe(true);
    expect(task.timeline.some((entry) => entry.text === "You approved the delivery")).toBe(true);
    // The work is on main, with the permission granted.
    expect(readFileSync(join(repo, "greeting.txt"), "utf8").trim()).toBe("Hello (with left-pad)");
    expect(task.findings.some((finding) => finding.severity === "suggestion")).toBe(true);
    await until(engine, (s) => s.tasks.find((entry) => entry.id === taskId)?.cleanup?.removedAt !== undefined, () => {});
    expect(existsSync(task.worktree!)).toBe(false);
    expect(readRef(join(repo, ".git"), `refs/heads/${task.branch!}`)).toBe(readRef(join(repo, ".git"), "refs/heads/main"));
    await until(engine, () => awakeChanges.at(-1) === false, () => {});
    });
  });
});
