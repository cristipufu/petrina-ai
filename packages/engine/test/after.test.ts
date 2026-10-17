import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";

const fake = join(import.meta.dir, "fake-agent.ts");
const temp = mkdtempSync(join(tmpdir(), "petrina-after-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

describe("Tasks that start after others land", () => {
  const repo = join(temp, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const engine = new Engine(join(temp, "data"), { agentCommand: () => ["bun", fake] });

  afterAll(() => {
    engine.shutdown();
    rmSync(temp, { recursive: true, force: true });
  });

  it("waits quietly until the tasks it waits for land, and refuses loops", async () => {
    const productId = await engine.addProduct(repo);
    engine.setPoolPaused(true);
    const first = engine.addTask({ productId, title: "Lay the groundwork", description: "First.", kind: "feature" });
    engine.setHeld(first, true);
    const second = engine.addTask({ productId, title: "Build on it", description: "Second.", kind: "feature" });

    engine.setAfter(second, [first]);
    engine.setPoolPaused(false);
    let task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task.state).toBe("queued");
    expect(task.statusLine).toBe("Waiting for “Lay the groundwork” to land");

    expect(() => engine.setAfter(second, [second])).toThrow();
    expect(() => engine.setAfter(first, [second])).toThrow();
    expect(() => engine.setAfter(second, ["task-missing"])).toThrow();

    // A cancelled prerequisite no longer blocks.
    engine.cancel(first);
    await Bun.sleep(50);
    task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task.state).not.toBe("queued");
  });
});
