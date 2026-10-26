import { expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { isCheckExecutorFacts, sameCheckExecutorFacts } from "@petrina/core";
import { checkOutputCapture, observeCheckExecutor, CHECK_EXECUTION_CONTRACT, CHECK_LAUNCH_POLICY } from "../../../src/check-environment.js";
import { runChecks } from "../../fixtures/check-runner.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

it("observes actual local executor APIs without a program, path, boot id or product override", () => {
  let restore: (() => void) | undefined;
  try {
    const spawning = spyOn(Bun, "spawn"); restore = () => { spawning.mockRestore(); };
    spawning.mockImplementation(() => { throw new Error("Executor facts must not start a program"); });
    const first = observeCheckExecutor(), second = observeCheckExecutor();
    expect(first.executorError).toBeUndefined();
    expect(first.executor).toEqual({ version: 1, adapter: "local-product-checks", contract: CHECK_EXECUTION_CONTRACT,
      launchPolicy: CHECK_LAUNCH_POLICY, platform: process.platform, architecture: process.arch, osRelease: os.release(), runtime: { name: "bun", version: Bun.version } });
    expect(isCheckExecutorFacts(first.executor)).toBe(true);
    expect(sameCheckExecutorFacts(first.executor, second.executor)).toBe(true);
    expect(spawning).not.toHaveBeenCalled();
  } finally { restore?.(); }
});

for (const mode of ["throws", "incomplete"] as const) it(`records ${mode} executor observation without today's fallback or changing the command`, async () => {
  const root = tempDir("petrina-check-executor-");
  let restoreRelease: (() => void) | undefined, restoreSpawn: (() => void) | undefined;
  try {
    const child = { exited: Promise.resolve(0), stdout: new Response("Actual stdout").body!, stderr: new Response("").body! } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const failure = new Error("Executor API unavailable");
    const release = spyOn(os, "release"); restoreRelease = () => { release.mockRestore(); };
    release.mockImplementation(() => { if (mode === "throws") throw failure; return ""; });
    const spawning = spyOn(Bun, "spawn"); restoreSpawn = () => { spawning.mockRestore(); };
    spawning.mockReturnValue(child);
    const [run] = await runChecks(root, [{ name: "Controlled completed handle", argv: ["controlled-completed-check"] }], process.env);
    expect(run!.ok).toBe(true);
    expect(run!.execution).toMatchObject({ started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof" });
    expect(run!.executor).toBeUndefined(); expect(run!.executorError).toBe(mode === "throws" ? failure.message : "The local check executor facts could not be observed completely");
    expect(run!.output).toBe("Actual stdout"); expect(run!.outputIdentity).toBeDefined();
    expect(spawning).toHaveBeenCalledTimes(1);
  } finally {
    try { restoreSpawn?.(); }
    finally { try { restoreRelease?.(); } finally { removeDir(root); } }
  }
});

it("hashes independent raw pipes across arbitrary chunks and complete empty output", () => {
  const capture = checkOutputCapture(), stdout = new Uint8Array([0, 255, 240, 159, 146, 169, 10]), stderr = new TextEncoder().encode("stderr\n");
  capture.add("stdout", stdout.subarray(0, 3)); capture.add("stderr", stderr); capture.add("stdout", stdout.subarray(3));
  expect(capture.finish(true).outputIdentity).toEqual({
    stdout: { algorithm: "sha256", bytes: stdout.byteLength, digest: crypto.createHash("sha256").update(stdout).digest("hex") },
    stderr: { algorithm: "sha256", bytes: stderr.byteLength, digest: crypto.createHash("sha256").update(stderr).digest("hex") },
  });
  const empty = checkOutputCapture().finish(true).outputIdentity;
  expect(empty?.stdout).toEqual({ algorithm: "sha256", bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
  expect(empty?.stderr).toEqual(empty?.stdout);
});

it("never fills an incomplete capture with empty pipe identities", () => {
  const capture = checkOutputCapture(); capture.add("stdout", new TextEncoder().encode("partial"));
  expect(capture.finish(false)).toEqual({});
  expect(capture.finish(true)).toEqual({});
});

for (const mode of ["create", "update", "digest"] as const) it(`keeps native command truth when output identity ${mode} fails`, async () => {
  const root = tempDir("petrina-check-identity-");
  let restoreHash: (() => void) | undefined, restoreSpawn: (() => void) | undefined;
  try {
    const child = { exited: Promise.resolve(0), stdout: new Response("Native command output").body!, stderr: new Response("Diagnostics\n").body! } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const failure = new Error(`Controlled ${mode} observation failure`), original = crypto.createHash;
    const hashing = spyOn(crypto, "createHash"); restoreHash = () => { hashing.mockRestore(); };
    hashing.mockImplementation((...args) => {
      if (mode === "create") throw failure;
      const hash = original(...args);
      if (mode === "update") hash.update = () => { throw failure; };
      if (mode === "digest") hash.digest = () => { throw failure; };
      return hash;
    });
    const spawning = spyOn(Bun, "spawn"); restoreSpawn = () => { spawning.mockRestore(); };
    spawning.mockReturnValue(child);
    const [run] = await runChecks(root, [{ name: "Controlled completed handle", argv: ["controlled-completed-check"] }], process.env);
    expect(run!.ok).toBe(true);
    expect(run!.execution).toMatchObject({ stdout: "eof", stderr: "eof", exit: { status: "reported", code: 0 } });
    expect(isCheckExecutorFacts(run!.executor)).toBe(true);
    expect(run!.outputIdentity).toBeUndefined(); expect(run!.outputIdentityError).toBe(failure.message);
    expect(run!.output).toBe("Native command outputDiagnostics\n");
    expect(spawning).toHaveBeenCalledTimes(1);
  } finally {
    try { restoreSpawn?.(); }
    finally { try { restoreHash?.(); } finally { removeDir(root); } }
  }
});

for (const code of [Number.NaN, -1]) it(`keeps executor facts but no complete identity for an invalid exit (${code})`, async () => {
  const root = tempDir("petrina-check-invalid-exit-");
  let restoreSpawn: (() => void) | undefined;
  try {
    const child = { exited: Promise.resolve(code), stdout: new Response("Complete stdout").body!, stderr: new Response("").body! } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn"); restoreSpawn = () => { spawning.mockRestore(); };
    spawning.mockReturnValue(child);
    const [run] = await runChecks(root, [{ name: "Controlled invalid exit", argv: ["controlled-invalid-check"] }], process.env);
    expect(run!.ok).toBe(false);
    expect(run!.execution?.exit.status).toBe("invalid");
    expect(isCheckExecutorFacts(run!.executor)).toBe(true);
    expect(run!.outputIdentity).toBeUndefined();
  } finally { try { restoreSpawn?.(); } finally { removeDir(root); } }
});

it("keeps a rejected exit unverified without turning drained or cancelled pipes into complete identities", async () => {
  // An explicit rejected completion, not a fabricated successful exit or an OS process identity.
  const root = tempDir("petrina-check-rejected-exit-");
  let restoreSpawn: (() => void) | undefined;
  try {
    const failure = new Error("The controlled handle could not report its exit"), exited = Promise.reject<number>(failure);
    void exited.catch(() => undefined); // Observe setup failure too; the boundary still receives the original rejection.
    const child = { exited, stdout: new Response("Available output").body!, stderr: new Response("").body! } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn"); restoreSpawn = () => { spawning.mockRestore(); };
    spawning.mockReturnValue(child);
    const [run] = await runChecks(root, [{ name: "Controlled rejected exit", argv: ["controlled-rejected-check"] }], process.env);
    expect(run!.ok).toBe(false);
    expect(run!.execution?.exit).toEqual({ status: "rejected" });
    expect(run!.execution?.failure).toEqual({ kind: "exit", message: failure.message });
    expect(run!.cleanupIncomplete).toBe(true);
    expect(isCheckExecutorFacts(run!.executor)).toBe(true);
    expect(run!.outputIdentity).toBeUndefined();
    expect(spawning).toHaveBeenCalledTimes(1);
  } finally { try { restoreSpawn?.(); } finally { removeDir(root); } }
});
