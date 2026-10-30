import { expect, it } from "vitest";
import { checkEvidence } from "../../fixtures/check-evidence.js";

it("bounds changing-input revalidation and never reports an obsolete pass as current", async () => {
  const f = await checkEvidence();
  let changes = 0;
  const running = f.controller.verify(f.scope, {
    check: () => f.host.check(f.signal.signal),
    currentChecks: () => [...f.declaration.commands],
    verify: () => f.record([f.run()], batch => {
      changes++;
      f.state.definition = String(changes + 3).repeat(64);
      batch.after.attempt.input.definition = f.state.definition;
      batch.finalState.definition = f.state.definition;
    }),
  });
  await expect(running).rejects.toThrow("check inputs kept changing");
  expect(f.scope.work.checks?.current).toBe(false);
  expect(f.task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(3);
  expect(f.scope.work.approvedSha).toBeUndefined();
  expect(changes).toBe(3);
  expect(f.notes.filter(note => note.startsWith("Check inputs changed while"))).toHaveLength(3);
});

it("uses the current declaration for a changed-input retry and stops on its completed failure", async () => {
  const f = await checkEvidence(), declarations: (readonly string[] | undefined)[] = [];
  const result = await f.controller.verify(f.scope, {
    check: () => f.host.check(f.signal.signal), currentChecks: () => [...f.declaration.commands],
    verify: async commands => {
      declarations.push(commands);
      if (declarations.length === 1) return f.record([f.run()], batch => {
        f.state.definition = "4".repeat(64);
        f.declaration.commands.splice(0, 1, "new-required-command");
        batch.after.attempt.input.definition = f.state.definition;
        batch.finalState.definition = f.state.definition;
      });
      return f.record([f.run(7, "Tests", "new-required-command")]);
    },
  }, ["test-product"]);
  expect(declarations).toEqual([["test-product"], ["new-required-command"]]);
  expect(result.kind).toBe("product-failed");
  expect(f.task.journey!.flatMap(step => step.checkAttempts ?? []).map(attempt => attempt.passed)).toEqual([false, undefined]);
  expect(f.scope.work.approvedSha).toBeUndefined();
});

it("does not retry an input change after cancellation settles the admitted observation", async () => {
  const f = await checkEvidence();
  let attempts = 0;
  await expect(f.controller.verify(f.scope, {
    check: () => f.host.check(f.signal.signal), currentChecks: () => f.declaration,
    verify: async () => {
      attempts++;
      const result = await f.record([f.run()], batch => { batch.after.attempt.input.definition = "4".repeat(64); });
      f.signal.abort();
      return result;
    },
  })).rejects.toThrow("Verification stopped");
  expect(attempts).toBe(1);
  expect(f.scope.work.checks?.current).toBe(false);
  expect(f.task.journey!.flatMap(step => step.reuses ?? [])).toEqual([]);
});

it("returns a missing-working-copy blocker without making further verification attempts", async () => {
  const f = await checkEvidence();
  delete f.scope.work.worktree;
  expect((await f.verify()).kind).toBe("blocked");
  expect(f.executions()).toBe(0);
  expect(f.task.journey).toBeUndefined();
});
