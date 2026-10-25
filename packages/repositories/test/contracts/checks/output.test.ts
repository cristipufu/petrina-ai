import { describe as originalDescribe } from "bun:test";
import { afterAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_EXIT_UNREPORTED } from "@petrina/core";


import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { runChecks } from "../../fixtures/check-runner.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const root = (prefix: string) => { const dir = tempDir(prefix); roots.push(dir); return dir; };

originalDescribe("a product's checks", () => {
it("captures the created log's descriptor identity even if its pathname is replaced before close", async () => {
    const dir = root("petrina-check-log-identity-");
    const logs = join(dir, "logs"), held = join(dir, "original.log");
    let logPath = "";
    const [run] = await runChecks(dir, [{ name: "Fail", argv: [process.execPath, "-e", 'process.stdout.write("original diagnostic"); process.exit(1)'] }], process.env, 30_000 * SLOW, undefined, logs, undefined, (event) => {
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

originalDescribe("a product's checks", () => {
it("keeps the original failure before later output, with separate durable logs for concurrent and repeated checks", async () => {
    const dir = root("petrina-checks-logs-");
    const logs = join(dir, "logs");
    const trace = "Original assertion: expected three agents, received four";
    const text = `before\n${trace}\n${"later passing test\n".repeat(20_000)}last line\n`;
    const script = join(dir, "fails.ts");
    writeFileSync(script, `await Bun.write(Bun.stdout, ${JSON.stringify(text)}); await Bun.write(Bun.stderr, 'stderr trace\\n'); process.exitCode = 1;`);
    const check = { name: "Same name", argv: [process.execPath, script] };
    const results = await runChecks(dir, [check, check], process.env, 30_000 * SLOW, undefined, logs);
    const [again] = await runChecks(dir, [check], process.env, 30_000 * SLOW, undefined, logs);
    expect(new Set([...results, again!].map((run) => run.logPath)).size).toBe(3);
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
    }
  });
});

originalDescribe("a product's checks", () => {
it("reports a log write failure without changing whether a command passed or failed", async () => {
    const dir = root("petrina-checks-log-error-");
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "Keep this file.");
    const results = await runChecks(dir, [
      { name: "Pass", argv: [process.execPath, "-e", "console.log('passed')"] },
      { name: "Fail", argv: [process.execPath, "-e", "console.error('real error'); process.exitCode = 7"] },
    ], process.env, 30_000 * SLOW, undefined, blocked);
    expect(results.map((run) => run.ok)).toEqual([true, false]);
    expect(results[1]!.output).toContain("real error");
    for (const run of results) {
      expect(run.logError).toBeTruthy();
      expect(run.logPath).toBeUndefined();
      expect(run.logFileIdentity).toBeUndefined();
      expect(run.logFileLength).toBeUndefined();
      expect(run.logFileBeginning).toBeUndefined();
    }
    expect(readFileSync(blocked, "utf8")).toBe("Keep this file.");
  });
});

originalDescribe("a check that misbehaves", () => {
it.skipIf(process.platform === "win32")("keeps only the end of a flood of output", async () => {
    const [run] = await runChecks(root("petrina-checks-flood-"), [{ name: "Noisy", argv: ["sh", "-c", "yes petrina | head -c 5000000; echo the-end"] }], process.env);
    expect(run!.ok).toBe(true);
    expect(run!.output.length).toBeLessThan(7000);
    expect(run!.output).toEndWith("the-end\n");
  });
});

originalDescribe("a check that closes its output", () => {
it.skipIf(process.platform === "win32")("keeps running inside its allowance when it sends its output to a file, and is still stopped at its deadline", async () => {
    const dir = root("petrina-checks-redirected-");
    const log = join(dir, "check.log");
    const started = Date.now();
    // The check closes Petrina's pipes at once and does valid work for longer than any grace would allow.
    const [run] = await runChecks(dir, [{ name: "Redirected", argv: ["sh", "-c", `exec >${JSON.stringify(log)} 2>&1; sleep 6.5; echo finished; exit 0`] }], process.env, 60_000 * SLOW, undefined, join(dir, "logs"));
    expect(run!.ok).toBe(true);
    expect(run!.timedOut).toBeUndefined();
    expect(run!.output).not.toContain(CHECK_EXIT_UNREPORTED);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
    expect(readFileSync(log, "utf8")).toBe("finished\n");
    const limited = Date.now();
    const [late] = await runChecks(dir, [{ name: "Past its limit", argv: ["sh", "-c", "exec >&- 2>&-; exec sleep 120"] }], process.env, 2_000, undefined, join(dir, "logs"));
    expect(late!.ok).toBe(false);
    expect(late!.timedOut).toBe(true);
    expect(late!.output).not.toContain(CHECK_EXIT_UNREPORTED);
    expect(Date.now() - limited).toBeLessThan(12_000);
  });
});
