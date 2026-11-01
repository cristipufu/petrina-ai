import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure, type CommandResult } from "../../../src/commands.js";
import { FIXTURE_JOURNAL } from "../../../src/fixture-retention.js";
import { removeFixtureRoot } from "../../../src/fixture-roots.js";
import { newProgramsStart, startsNewProgram } from "../../../src/new-program.js";
import { rejectionOf } from "../../../src/rejections.js";
import { MOST_SLOW } from "../../../src/slow.js";

const completed = (code = 0): CommandResult => ({ code, stdout: "", stderr: "" });

for (const code of [0, 7]) it.skipIf(process.platform === "win32")(`disposes the new-program root after supplied canonical completion ${code}`, async () => {
  let root = "";
  try {
    const running = startsNewProgram(10_000, async (argv, options) => {
      root = options?.cwd ?? "";
      expect(argv).toEqual([join(root, "new-program")]);
      expect(readFileSync(argv[0]!, "utf8")).toBe("#!/bin/sh\nexit 0\n");
      const timeout = options?.timeoutMs ?? NaN;
      expect(timeout).toBeGreaterThanOrEqual(10_000);
      expect(timeout).toBeLessThanOrEqual(10_000 * MOST_SLOW);
      expect(timeout % 10_000).toBe(0);
      const journal = process.env[FIXTURE_JOURNAL];
      if (!journal) throw new Error("Run this contract through the private workspace runner");
      const name = createHash("sha256").update(root).digest("hex") + ".json";
      expect(JSON.parse(readFileSync(join(journal, name), "utf8"))).toEqual({ version: 1, root });
      return completed(code);
    });
    if (code === 0) await running;
    else {
      const error = await rejectionOf(running);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe("The new program exited with code 7.");
    }
    expect(existsSync(root)).toBe(false);
  } finally { if (root) removeFixtureRoot(root); }
});

const failures = [
  { name: "confirmed stop", error: new CommandFailure("Stopped and drained", "timeout", "partial", "diagnostic", "confirmed"), retained: false },
  { name: "unconfirmed stop", error: new CommandFailure("Stop unconfirmed", "timeout", "partial", "diagnostic", "unconfirmed"), retained: true },
  { name: "unknown start", error: new CommandFailure("Starter did not report ownership", "start"), retained: true },
  { name: "unknown error", error: new Error("Reader acquisition failed"), retained: true },
  { name: "undefined rejection", error: undefined, retained: true },
];
for (const { name, error: failure, retained } of failures) it.skipIf(process.platform === "win32")(`preserves the original ${name} and its new-program root authority`, async () => {
  let root = "";
  try {
    const error = await rejectionOf(startsNewProgram(10_000, (_argv, options) => {
      root = options?.cwd ?? "";
      return Promise.reject(failure);
    }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(failure);
    expect((error as Error).message).toContain("within 10 seconds.");
    expect(existsSync(root)).toBe(retained);
  } finally {
    // These supplied outcomes start no actors. Independent terminal cleanup discharges retained evidence.
    if (root) removeFixtureRoot(root);
  }
});

it.skipIf(process.platform === "win32")("retains a synchronous unknown runner failure without replacing its cause", async () => {
  const failure = new Error("Entered runner threw before returning its promise");
  let root = "";
  try {
    const error = await rejectionOf(startsNewProgram(10_000, (_argv, options) => {
      root = options?.cwd ?? "";
      throw failure;
    }));
    expect((error as Error).cause).toBe(failure);
    expect(existsSync(root)).toBe(true);
  } finally { if (root) removeFixtureRoot(root); }
});

it.skipIf(process.platform === "win32")("keeps the actual new-program files while a supplied command is pending", async () => {
  const entered = Promise.withResolvers<void>(), result = Promise.withResolvers<CommandResult>();
  let root = "";
  const running = startsNewProgram(10_000, (_argv, options) => {
    root = options?.cwd ?? "";
    entered.resolve();
    return result.promise;
  });
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error("The startup probe completed before its runner was entered"); })]);
    expect(existsSync(join(root, "new-program"))).toBe(true);
    result.resolve(completed());
    await running;
    expect(existsSync(root)).toBe(false);
  } finally {
    result.resolve(completed());
    try { await running; }
    finally { if (root) removeFixtureRoot(root); }
  }
});

it("keeps the cached native new-program startup boundary", async () => {
  const first = newProgramsStart(), again = newProgramsStart();
  expect(again).toBe(first);
  await first;
});
