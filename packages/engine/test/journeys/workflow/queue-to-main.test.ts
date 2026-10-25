import { FAKE_AGENT } from "../../fixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type State } from "@petrina/core";
import { Engine } from "../../engine.js";
import { git, removeDir, SLOW } from "../../fixtures.js";

const fake = FAKE_AGENT;
const temp = mkdtempSync(join(tmpdir(), "petrina-engine-"));

async function makeRepo(name = "repo"): Promise<string> {
  const repo = join(temp, name);
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

let retainFiles = false;
afterAll(() => { if (!retainFiles) removeDir(temp); });

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

describe("Engine with a fake ACP agent", () => {
  let repo = "";
  beforeAll(async () => { repo = await makeRepo(); });
  const awakeChanges: boolean[] = [];
  const engine = new Engine(join(temp, "data"), { agentCommand: () => [process.execPath, fake], awakeObserver: (active) => awakeChanges.push(active) });

  afterAll(async () => {
    try { await engine.shutdown(); }
    catch (error) { retainFiles = true; throw error; }
  });

  it("takes a task from the queue to a commit on main, asking the coordinator along the way", async () => {
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
    expect(await git(repo, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
    expect(task.findings.some((finding) => finding.severity === "suggestion")).toBe(true);
    await until(engine, (s) => s.tasks.find((entry) => entry.id === taskId)?.cleanup?.removedAt !== undefined, () => {});
    expect(existsSync(task.worktree!)).toBe(false);
    expect(await git(repo, "rev-parse", task.branch!)).toBe(await git(repo, "rev-parse", "main"));
    await until(engine, () => awakeChanges.at(-1) === false, () => {});
  });
});
