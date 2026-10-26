import { describe as originalDescribe } from "bun:test";
import { afterAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_EXIT_UNREPORTED } from "@petrina/core";


import { checkProcessFixtures } from "../../fixtures/check-processes.js";
import { quoteGitShellWord } from "@petrina/test-support/git-shell-word";
import { childState } from "@petrina/platform/process-tree";
import { SLOW } from "@petrina/test-support/slow";
const worlds = checkProcessFixtures();
afterAll(worlds.close);

originalDescribe("a product's checks", () => {
it("captures the created log's descriptor identity even if its pathname is replaced before close", async () => {
  await worlds.use("petrina-check-log-identity-", async fixture => {
    const dir = fixture.dir;
    const logs = join(dir, "logs"), held = join(dir, "original.log");
    let logPath = "";
    const [run] = await fixture.checks([{ name: "Fail", argv: [process.execPath, "-e", 'process.stdout.write("original diagnostic"); process.exit(1)'] }], process.env, 30_000 * SLOW, undefined, logs, undefined, (event) => {
      if (event.kind !== "started") return;
      logPath = join(logs, readdirSync(logs)[0]!);
      renameSync(logPath, held);
      writeFileSync(logPath, "replacement file");
    });
    expect(run!.logComplete).toBe(true);
    expect(run!.logFileIdentity).toBeDefined();
    // Length and beginning also come from the opened file, not the replacement at its old name.
    expect(run!.logFileLength).toBe(Buffer.byteLength("original diagnostic"));
    expect(run!.logFileBeginning).toBe(createHash("sha256").update("original diagnostic").digest("hex"));
    unlinkSync(logPath);
    renameSync(held, logPath);
    const exact = statSync(logPath, { bigint: true });
    expect(run!.logFileIdentity).toEqual({ device: exact.dev.toString(), inode: exact.ino.toString() });

  });
});
});

originalDescribe("a product's checks", () => {
it("keeps the original failure before later output, with separate durable logs for concurrent and repeated checks", async () => {
  await worlds.use("petrina-checks-logs-", async fixture => {
    const dir = fixture.dir;
    const logs = join(dir, "logs");
    const trace = "Original assertion: expected three agents, received four";
    const text = `before\n${trace}\n${"later passing test\n".repeat(20_000)}last line\n`;
    const script = join(dir, "fails.ts");
    writeFileSync(script, `await Bun.write(Bun.stdout, ${JSON.stringify(text)}); await Bun.write(Bun.stderr, 'stderr trace\\n'); process.exitCode = 1;`);
    const check = { name: "Same name", argv: [process.execPath, script] };
    const results = await fixture.checks([check, check], process.env, 30_000 * SLOW, undefined, logs);
    const [again] = await fixture.checks([check], process.env, 30_000 * SLOW, undefined, logs);
    expect(new Set([...results, again!].map((run) => run.logPath)).size).toBe(3);
    expect(fixture.children()).toHaveLength(3);
    expect(await Promise.all(fixture.children().map(child => childState(child.pid)))).toEqual(["ended", "ended", "ended"]);
    for (const run of [...results, again!]) {
      expect(run.ok).toBe(false);
      expect(run.logError).toBeUndefined();
      expect(run.output.length).toBeLessThan(7000);
      expect(run.output).not.toContain(trace);
      const saved = readFileSync(run.logPath!, "utf8");
      expect(saved).toContain(trace);
      expect(saved).toContain("stderr trace\n");
      // The two pipes can interleave; every stdout byte must still be there in order.
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      expect(digest(saved.replace("stderr trace\n", ""))).toBe(digest(text));
      if (process.platform !== "win32") expect(statSync(run.logPath!).mode & 0o777).toBe(0o600);
      // The recorded fingerprint is bounded to the beginning; the length is the exact settled total.
      const raw = readFileSync(run.logPath!);
      expect(run.logFileLength).toBe(raw.length);
      expect(run.logFileBeginning).toBe(createHash("sha256").update(raw.subarray(0, 4096)).digest("hex"));
      expect(run.outputIdentity).toEqual({
        stdout: { algorithm: "sha256", bytes: Buffer.byteLength(text), digest: digest(text) },
        stderr: { algorithm: "sha256", bytes: Buffer.byteLength("stderr trace\n"), digest: digest("stderr trace\n") },
      });
      expect(run.outputIdentityError).toBeUndefined();
    }

  });
});
});

originalDescribe("a product's checks", () => {
it("reports a log write failure without changing whether a command passed or failed", async () => {
  await worlds.use("petrina-checks-log-error-", async fixture => {
    const dir = fixture.dir;
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "Keep this file.");
    const passStderr = new Uint8Array([0, 255, 240, 159, 146, 169, 10]);
    const results = await fixture.checks([
      { name: "Pass", argv: [process.execPath, "-e", `console.log('passed'); process.stderr.write(Uint8Array.from(${JSON.stringify([...passStderr])}));`] },
      { name: "Fail", argv: [process.execPath, "-e", "console.error('real error'); process.exitCode = 7"] },
    ], process.env, 30_000 * SLOW, undefined, blocked);
    expect(results.map((run) => run.ok)).toEqual([true, false]);
    expect(fixture.children()).toHaveLength(2);
    expect(await Promise.all(fixture.children().map(child => childState(child.pid)))).toEqual(["ended", "ended"]);
    expect(results[1]!.output).toContain("real error");
    for (const run of results) {
      expect(run.logError).toBeTruthy();
      expect(run.execution).toMatchObject({ stdout: "eof", stderr: "eof", cleanup: "not-requested", outputCleanup: "not-requested" });
      expect(run.execution?.failure).toBeUndefined();
      expect(run.logPath).toBeUndefined();
      expect(run.logFileIdentity).toBeUndefined();
      expect(run.logFileLength).toBeUndefined();
      expect(run.logFileBeginning).toBeUndefined();
      const stdout = run.name === "Pass" ? "passed\n" : "", stderr = run.name === "Pass" ? passStderr : new TextEncoder().encode("real error\n");
      expect(run.outputIdentity).toEqual({
        stdout: { algorithm: "sha256", bytes: Buffer.byteLength(stdout), digest: createHash("sha256").update(stdout).digest("hex") },
        stderr: { algorithm: "sha256", bytes: stderr.byteLength, digest: createHash("sha256").update(stderr).digest("hex") },
      });
      expect(run.outputIdentityError).toBeUndefined();
    }
    expect(readFileSync(blocked, "utf8")).toBe("Keep this file.");

  });
});
});

it("records complete empty pipes from an actual command without a diagnostic log", async () => {
  await worlds.use("petrina-empty-check-output-", async fixture => {
  const [run] = await fixture.checks([{ name: "Empty", argv: [process.execPath, "-e", "process.exit(0)"] }], process.env, 30_000 * SLOW);
  const empty = { algorithm: "sha256" as const, bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  expect(run!.ok).toBe(true);
  expect(run!.outputIdentity).toEqual({ stdout: empty, stderr: empty });
  expect(run!.outputIdentityError).toBeUndefined();
  expect(run!.logPath).toBeUndefined();

  });
});

originalDescribe("a check that misbehaves", () => {
it.skipIf(process.platform === "win32")("keeps only the end of a flood of output", async () => {
  await worlds.use("petrina-checks-flood-", async fixture => {
    const [run] = await fixture.checks([{ name: "Noisy", argv: [process.execPath, "-e", 'await Bun.write(Bun.stdout, "petrina\\n".repeat(Math.ceil(5_000_000 / 8)).slice(0, 5_000_000)); console.log("the-end");'] }], process.env);
    expect(run!.ok).toBe(true);
    expect(run!.output.length).toBeLessThan(7000);
    expect(run!.output).toEndWith("the-end\n");
    expect(run!.outputIdentity?.stdout.bytes).toBe(5_000_008);

  });
});
});

originalDescribe("a check that closes its output", () => {
it.skipIf(process.platform === "win32")("keeps running inside its allowance when it sends its output to a file, and is still stopped at its deadline", async () => {
  await worlds.use("petrina-checks-redirected-", async fixture => {
    const dir = fixture.dir;
    const log = join(dir, "check.log");
    const validWork = await fixture.program("await Bun.sleep(6500);", "valid-work.json");
    const lateWork = await fixture.program("await new Promise(() => undefined);", "late-work.json");
    fixture.observeActor(join(dir, "valid-work.json"));
    const started = Date.now();
    // The check closes Petrina's pipes at once and does valid work for longer than any grace would allow.
    const [run] = await fixture.checks([{ name: "Redirected", argv: ["sh", "-c", `exec >${JSON.stringify(log)} 2>&1; ${quoteGitShellWord(process.execPath)} -e ${quoteGitShellWord(validWork)}; echo finished; exit 0`] }], process.env, 60_000 * SLOW, undefined, join(dir, "logs"));
    expect(run!.ok).toBe(true);
    expect(run!.timedOut).toBeUndefined();
    expect(run!.output).not.toContain(CHECK_EXIT_UNREPORTED);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
    expect(readFileSync(log, "utf8")).toBe("finished\n");
    fixture.observeActor(join(dir, "late-work.json"));
    const limited = Date.now();
    const [late] = await fixture.checks([{ name: "Past its limit", argv: ["sh", "-c", `exec >&- 2>&-; exec ${quoteGitShellWord(process.execPath)} -e ${quoteGitShellWord(lateWork)}`] }], process.env, 2_000, undefined, join(dir, "logs"));
    expect(late!.ok).toBe(false);
    expect(late!.timedOut).toBe(true);
    expect(late!.output).not.toContain(CHECK_EXIT_UNREPORTED);
    expect(Date.now() - limited).toBeLessThan(12_000);
    expect(fixture.children()).toHaveLength(2);
    expect(await childState(fixture.children()[1]!.pid)).toBe("ended");

  });
});
});
