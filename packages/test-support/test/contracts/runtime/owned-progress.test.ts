import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDir, tempDir, waitFor, waitForFile } from "../../../src/fixtures.js";
import { rejectionOf } from "../../../src/rejections.js";

for (const error of [new Error("The owner failed"), undefined]) it("propagates the owning operation's rejection even when it is " + (error === undefined ? "undefined" : "an Error"), async () => {
  const owner = Promise.withResolvers<void>(), progress = Promise.withResolvers<string>();
  const pending = waitFor(() => progress.promise, "owned progress", undefined, { during: owner.promise });
  owner.reject(error);
  try { expect(await rejectionOf(pending)).toBe(error); }
  finally { progress.resolve("late progress"); }
});

it("stops an asynchronous predicate after successful owner completion without claiming missing progress", async () => {
  const owner = Promise.withResolvers<void>(), progress = Promise.withResolvers<string>();
  const pending = waitFor(() => progress.promise, "the expected response", undefined, { during: owner.promise });
  owner.resolve();
  try {
    const error = await rejectionOf(pending);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The operation completed before the expected response");
  } finally { progress.reject(new Error("Late predicate failure remains observed")); }
});

for (const asynchronous of [false, true]) it("retains already available " + (asynchronous ? "asynchronous" : "synchronous") + " progress after owner completion", async () => {
  const result = await waitFor(() => asynchronous ? Promise.resolve("recorded") : "recorded", "recorded progress", undefined, { during: Promise.resolve() });
  expect(result).toBe("recorded");
});

it("retains progress that already arrived even when the owner failed afterward", async () => {
  const error = new Error("The owner failed after recording");
  expect(await waitFor(() => "recorded", "recorded progress", undefined, { during: Promise.reject(error) })).toBe("recorded");
});

for (const error of [new Error("The asynchronous predicate failed"), undefined]) it("preserves an asynchronous predicate's " + (error === undefined ? "undefined rejection" : "error") + " while its owner remains live", async () => {
  const owner = Promise.withResolvers<void>();
  try { expect(await rejectionOf(waitFor(() => Promise.reject(error), "predicate result", undefined, { during: owner.promise }))).toBe(error); }
  finally { owner.resolve(); }
});

it("does not keep polling false progress after its owner finishes", async () => {
  const owner = Promise.withResolvers<void>();
  let checks = 0;
  const pending = waitFor(() => { checks++; owner.resolve(); return false; }, "the recorded handoff", undefined, { during: owner.promise });
  expect((await rejectionOf(pending) as Error).message).toBe("The operation completed before the recorded handoff");
  expect(checks).toBe(1);
});

it("shares completion semantics with real private file progress, including rejection with undefined", async () => {
  const root = tempDir("petrina-owned-progress-"), file = join(root, "ready");
  try {
    expect(await rejectionOf(waitForFile(file, { during: Promise.reject(undefined) }))).toBeUndefined();
    const ended = await rejectionOf(waitForFile(file, { during: Promise.resolve() }));
    expect((ended as Error).message).toContain("The operation completed before its progress file appeared:");
    writeFileSync(file, "recorded");
    await waitForFile(file, { during: Promise.reject(new Error("Completed after writing")) });
    expect(await waitFor(() => true, "the existing file", undefined, { during: Promise.resolve() })).toBe(true);
  } finally { removeDir(root); }
});
