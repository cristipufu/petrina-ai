import { FAKE_AGENT } from "../../fixtures.js";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("answers to a request missing from the inbox", () => {
  it("resumes its live waiter without an extra agent turn, and keeps other open permissions blocking", async () => {
    const engine = new Engine(join(temp, "orphan-data"), { agentCommand: () => [process.execPath, fake] });
    try {
      const repo = await makeRepo("orphan-repo");
      const productId = await engine.addProduct(repo);
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
      expect(await git(repo, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
    } finally {
      try { await engine.shutdown(); }
      catch (error) { retainFiles = true; throw error; }
    }
  });
});
