import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { removeDir, tempDir, waitForFile } from "../../../src/fixtures.js";
import { writeFixtureJson } from "../../../src/fixture-json.js";
import { rejectionOf } from "../../../src/rejections.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function marker() { const root = tempDir("petrina-progress-wait-"); roots.push(root); return join(root, "started.json"); }

it("waits for real progress while its operation remains open", async () => {
  const file = marker(), work = Promise.withResolvers<void>();
  const waiting = waitForFile(file, { during: work.promise, timeoutMs: 300 });
  writeFixtureJson(file, { started: true });
  await waiting;
  work.resolve();
});

it("reports an operation that finished without progress instead of waiting for its deadline", async () => {
  const file = marker();
  const error = await rejectionOf(waitForFile(file, { during: Promise.resolve(), timeoutMs: 300 }));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`The operation completed before its progress file appeared: ${file}`);
});

for (const error of [new Error("The owned operation failed"), undefined]) it(`preserves an operation's rejected ${error ? "error" : "undefined reason"} before progress`, async () => {
  expect(await rejectionOf(waitForFile(marker(), { during: Promise.reject(error), timeoutMs: 300 }))).toBe(error);
});

it("accepts observed progress even if its operation has already ended or failed", async () => {
  for (const during of [Promise.resolve(), Promise.resolve().then(() => { throw new Error("Failed after starting"); })]) {
    const file = marker(); writeFixtureJson(file, { started: true });
    await waitForFile(file, { during, timeoutMs: 300 });
  }
});

it("keeps a bounded file-only wait when no owning operation is available", async () => {
  const file = marker();
  expect((await rejectionOf(waitForFile(file, { timeoutMs: 1 })) as Error).message).toBe(`Timed out waiting for ${file}`);
});
