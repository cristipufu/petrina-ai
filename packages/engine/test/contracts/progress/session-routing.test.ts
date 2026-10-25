import { expect, it } from "bun:test";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";
it("names each real repository context on its report without allocating duplicate activity ids", async () => {
  const root = tempDir("session-routing-");
  const engine = new Engine(root, { admissionsClosed: true });
  try {
    engine.s.products.push(...["first", "second"].map(id => ({ id, name: id, repo: `local/${id}`, tone: "blue" as const })));
    const task = engine.task(engine.addTask({ productId: "first", title: "Shared reports", backlog: true }))!;
    task.repositories = ["first", "second"].map(productId => ({ productId, delivery: "local", completedStages: [] }));
    engine.say({ task, work: task.repositories[0]! }, "agent", "First product checked", "builder", "sol-high");
    const first = task.session.at(-1)!;
    engine.say({ task, work: task.repositories[1]! }, "agent", "Second product checked", "builder", "sol-high");
    const second = task.session.at(-1)!;
    expect(first.productId).toBe("first");
    expect(second.productId).toBe("second");
    engine.say(task, "activity", "Working");
    const sequence = engine.s.seq;
    engine.say(task, "activity", "Working");
    expect(engine.s.seq).toBe(sequence);
    expect(task.session.filter(line => line.text === "Working")).toHaveLength(1);
  } finally { await engine.shutdown(); removeDir(root); }
});
