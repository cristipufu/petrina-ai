import { expect, it } from "vitest";
import { learningOffersFixture } from "../../fixtures/learnings.js";

it("offers complete distinct instructions and restores the caller's running state after its nonblocking offer", async () => {
  const f = learningOffersFixture(), product = f.state.products[0]!;
  f.task.state = "running";
  f.files.set(f.scope.work, "- Run bun test --parallel.\n");
  product.learnings = [{ text: "Use scripts/check-one.sh.", fromTask: f.task.id, at: 0 }];
  product.learningsDeclined = ["Run tests without installing dependencies."];
  const instructions = ["Do not run bun test --parallel; use the package command.", "Use scripts/check/one.sh.", "Run tests after installing dependencies."];
  await f.controller.note(f.scope, instructions, "builder", "builder-profile");
  await f.controller.note(f.scope, instructions.map(text => `  ${text}  `), "code-reviewer", "reviewer-profile");
  await f.controller.offer(f.scope);
  expect(f.requested).toHaveLength(1);
  expect(f.requested[0]!.body).toBe(instructions.map(text => `- ${text}`).join("\n"));
  expect(f.requested[0]!.by).toEqual({ roleId: "builder", profileId: "builder-profile" });
  expect(f.task.state).toBe("running");
  expect(f.scope.work.lessons).toBeUndefined();
});

it("reads accepted queues after the authoritative file observation, retaining the bound product across that wait", async () => {
  const f = learningOffersFixture(), product = f.state.products[0]!, text = "Inspect the focused checks before delivery.";
  f.scope.work.lessons = [{ text, roleId: "builder", profileId: "builder-profile", at: 100 }];
  let release!: (value: string) => void;
  f.host.authoritativeFile = () => new Promise(resolve => { release = resolve; });
  const pending = f.controller.offer(f.scope);
  f.state.products[0] = { ...product, learnings: [] };
  product.learnings = [{ text, fromTask: "other", at: 150 }];
  release(""); await pending;
  expect(f.requested).toEqual([]);
  expect(f.scope.work.lessons).toBeUndefined();
});

it("consumes only learning offers, preserves complete selected text and records declined instructions separately", () => {
  const f = learningOffersFixture(), product = f.state.products[0]!, kept = "Use scripts/check-one.sh before delivering the full change.", declined = "Use the existing fixture's private repositories.";
  const question = f.offer("A real question", undefined, "question");
  f.controller.accept(question.id);
  expect(f.removed).toEqual([]);
  const item = f.offer(`- ${kept}\n- ${declined}`);
  f.controller.accept(item.id, [0]);
  expect(product.learnings).toEqual([{ text: kept, at: 200, fromTask: f.task.id }]);
  expect(product.learningsDeclined).toEqual([declined]);
  expect(f.checkpoints).toEqual([f.task]);
  const later = f.offer(`- ${kept}`);
  f.controller.decline(later.id);
  expect(product.learnings).toEqual([{ text: kept, at: 200, fromTask: f.task.id }]);
  expect(product.learningsDeclined).toEqual([declined, kept]);
  expect(f.state.inbox).toEqual([question]);
});
