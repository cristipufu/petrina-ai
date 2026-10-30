import { expect, it } from "bun:test";
import { gitCaller, isGitCaller } from "../../../src/resources/git-callers.js";
import { ResourceSummary } from "../../../src/resources/summary.js";

it("attributes a Git launch to the repository's engine caller outside command plumbing", () => {
  expect(gitCaller(`Error
    at begin (/checkout/packages/test-support/src/resources/events.ts:61:8)
    at runCommand (/checkout/packages/test-support/src/commands.ts:145:3)
    at head (/checkout/packages/repositories/src/git.ts:500:1)
    at captureState (/checkout/packages/engine/src/product-checks.ts:370:9)
    at example (/checkout/packages/engine/test/contracts/checks/example.test.ts:12:4)`, "/checkout/"))
    .toBe("packages/engine/src/product-checks.ts:370");
});

it("retains a direct fixture caller and a Git boundary when no outer source frame is available", () => {
  expect(gitCaller(`Error
    at git (/checkout/packages/test-support/src/commands.ts:460:1)
    at example (/checkout/packages/engine/test/contracts/checks/example.test.ts:12:4)`, "/checkout"))
    .toBe("packages/engine/test/contracts/checks/example.test.ts:12");
  expect(gitCaller("Error\n    at head (/checkout/packages/repositories/src/git.ts:500:1)", "/checkout"))
    .toBe("packages/repositories/src/git.ts:500");
  expect(gitCaller(`Error
    at begin (/checkout/packages/test-support/src/resources/events.ts:61:8)
    at run (/checkout/packages/repositories/src/git.ts:182:3)
    at must (/checkout/packages/repositories/src/git.ts:243:9)
    at head (/checkout/packages/repositories/src/git.ts:748:3)`, "/checkout"))
    .toBe("packages/repositories/src/git.ts:748");
  expect(gitCaller(`Error
    at begin (/checkout/packages/test-support/src/resources/events.ts:61:8)
    at run (/checkout/packages/repositories/src/git/exec.ts:130:3)
    at head (/checkout/packages/repositories/src/git/revisions.ts:95:3)
    at captureState (/checkout/packages/engine/src/product-checks.ts:370:9)`, "/checkout"))
    .toBe("packages/engine/src/product-checks.ts:370");
  expect(gitCaller(`Error
    at run (/checkout/packages/repositories/src/git/exec.ts:130:3)
    at head (/checkout/packages/repositories/src/git/revisions.ts:95:3)`, "/checkout"))
    .toBe("packages/repositories/src/git/revisions.ts:95");
});

it("normalizes Windows separators without retaining the absolute checkout location", () => {
  expect(gitCaller("Error\n    at capture (C:\\work\\project\\packages\\engine\\src\\context.ts:51:9)", "C:\\work\\project"))
    .toBe("packages/engine/src/context.ts:51");
});

it("rejects unrelated checkouts, messages, malformed locations and non-source frames", () => {
  for (const stack of [
    "Error: /checkout/packages/engine/src/context.ts:51:9",
    "Error\n    at capture (/checkout-other/packages/engine/src/context.ts:51:9)",
    "Error\n    at capture (/checkout/packages/engine/src/context.ts:unknown:9)",
    "Error\n    at capture (/checkout/node_modules/provider/src/context.ts:51:9)",
  ]) expect(gitCaller(stack, "/checkout")).toBeUndefined();
  expect(gitCaller(undefined, "/checkout")).toBeUndefined();
  expect(gitCaller("Error", "")).toBeUndefined();
});

it("bounds captured locations and does not scan an unbounded stack", () => {
  expect(gitCaller(`Error\n    at capture (/checkout/packages/engine/src/${"x".repeat(240)}.ts:1:1)`, "/checkout")).toBeUndefined();
  expect(gitCaller(`${"Error\n".repeat(40)}    at capture (/checkout/packages/engine/src/context.ts:1:1)`, "/checkout")).toBeUndefined();
  expect(gitCaller(`${"x".repeat(16_384)}\n    at capture (/checkout/packages/engine/src/context.ts:1:1)`, "/checkout")).toBeUndefined();
});

it("ranks actual Git launch callers once and keeps unavailable caller evidence explicit", () => {
  const result = new ResourceSummary(), caller = "packages/engine/src/product-checks.ts:370";
  const first = { kind: "spawn", id: "one", program: "git", operation: "status", caller };
  result.accept(first); result.accept(first);
  result.accept({ kind: "exit", id: "one", program: "git", operation: "status", caller });
  result.accept({ kind: "spawn", id: "two", program: "git", operation: "show", caller });
  result.accept({ kind: "spawn", id: "three", program: "git", operation: "status" });
  result.accept({ kind: "spawn", id: "four", program: "git", caller: "/outside/source.ts:1" });
  result.accept({ kind: "spawn", id: "five", program: "bun", caller });
  expect(result.report().gitLaunchesWithCaller).toBe(2);
  expect(result.report().gitLaunchesWithoutCaller).toBe(2);
  expect(result.report().topGitCallers).toEqual([{ caller, launches: 2, operations: { status: 1, show: 1 } }]);
  expect(new ResourceSummary().report().topGitCallers).toEqual([]);
  expect(isGitCaller("packages/engine/src/context.ts:1\nprivate value")).toBe(false);
  expect(isGitCaller("packages/engine/src/../../private.ts:1")).toBe(false);
  expect(isGitCaller("packages/engine/src//context.ts:1")).toBe(false);
});
