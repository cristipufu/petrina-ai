import { afterAll, expect, it } from "bun:test";
import { Kernel, MAX_SESSION_LINES, type MTask } from "../src/kernel.js";
import { removeDir, tempDir } from "./support.js";

class Quiet extends Kernel {
  schedule(): void {}
  startDriver(): void {}
  tidy(): void {}
}

const root = tempDir("petrina-session-cap-");
afterAll(() => removeDir(root));

function kernel(): Quiet {
  return new Quiet(root, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
}

function task(id: string, images: boolean): MTask {
  return {
    id, title: "Check a page", productId: "product-1", repository: { productId: "product-1", delivery: "local" }, state: "running", column: "build", priority: 0, queued: [], timeline: [],
    session: Array.from({ length: MAX_SESSION_LINES }, (_, index) => ({
      id: `earlier-${id}-${index}`, at: 1, from: "agent" as const, text: "An earlier report", roleId: "code-reviewer", profileId: "opus-high",
      ...(images ? { images: [{ id: "old-picture", caption: "An earlier page" }] } : {}),
    })),
  } as unknown as MTask;
}

it("keeps each agent's latest report when another update arrives before its pictures are attached", () => {
  const engine = kernel();
  try {
    const pictured = task("pictured", true);
    engine.s.tasks.push(pictured);
    engine.say(pictured, "agent", "The builder checked the page", "builder", "sol-high");
    const report = pictured.session.at(-1)!;
    engine.say(pictured, "activity", "Another reviewer is checking", "code-reviewer", "opus-high");
    expect(pictured.session).toContain(report);
    report.images = [{ id: "builder-picture", caption: "The checked page" }];
    engine.say(pictured, "activity", "Still checking");
    expect(pictured.session.find((line) => line.id === report.id)?.images?.[0]?.id).toBe("builder-picture");

    const busy = task("busy", false);
    engine.s.tasks.push(busy);
    engine.say(busy, "agent", "The builder checked the page", "builder", "sol-high");
    const builder = busy.session.at(-1)!;
    engine.say(busy, "agent", "The reviewer checked the page", "code-reviewer", "opus-low");
    const reviewer = busy.session.at(-1)!;
    engine.say(busy, "activity", "Another reviewer is checking", "code-reviewer", "opus-high");
    expect(busy.session).toContain(builder);
    expect(busy.session).toContain(reviewer);
    expect(busy.session).toHaveLength(MAX_SESSION_LINES);
    expect(busy.session.at(-1)?.from).toBe("activity");
  } finally {
    engine.tracking.close();
    engine.store.close();
  }
});

it("keeps the latest report for each product when the same builder works across products", () => {
  const engine = kernel();
  try {
    const shared = task("shared", false);
    shared.repositories = ["first", "second"].map((productId) => ({ productId, delivery: "local", completedStages: [] }));
    engine.s.tasks.push(shared);
    shared.productId = "first";
    engine.say(shared, "agent", "First product checked", "builder", "sol-high");
    const first = shared.session.at(-1)!;
    shared.productId = "second";
    engine.say(shared, "agent", "Second product checked", "builder", "sol-high");
    const second = shared.session.at(-1)!;
    for (let index = 0; index < MAX_SESSION_LINES; index++) engine.say(shared, "activity", `Checking the shared work ${index}`);
    expect(shared.session).toContain(first);
    expect(shared.session).toContain(second);
    expect(first.productId).toBe("first");
    expect(second.productId).toBe("second");
    expect(shared.session).toHaveLength(MAX_SESSION_LINES);
  } finally {
    engine.tracking.close();
    engine.store.close();
  }
});
