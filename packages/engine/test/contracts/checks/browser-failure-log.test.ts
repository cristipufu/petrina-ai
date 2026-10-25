import { expect, it } from "bun:test";
import { TEST_RUNNER } from "@petrina/test-support/run";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLEANUP_NOTE } from "@petrina/agent-runtime/browser";
import { runChecks, removeDir, SLOW, tempDir, testBrowserRoot } from "../../support.js";
import { afterAll } from "bun:test";
const browsers = testBrowserRoot();
afterAll(() => removeDir(browsers));
const notePattern = (fields: string) => new RegExp(`^${`${CLEANUP_NOTE} ${fields}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("elapsed=\\?", "elapsed=\\d+ms")}\\n?$`);

it.skipIf(process.platform === "win32")("a failing test run leaves the whole note line in its saved check log", async () => {
  const work = tempDir("petrina-browser-note-log-");
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // A controlled failing test file through the engine's own parallel runner, as the Tests check runs it, in this
  // test's private folders. The process list is unreadable there. No configured check or live log is involved.
  writeFileSync(join(work, "shutdown.test.ts"), `import { it } from "bun:test";
import { rmSync } from "node:fs";
import { AgentBrowser } from ${JSON.stringify(import.meta.resolve("@petrina/agent-runtime/browser"))};
it("stops a browser whose helper was killed", async () => {
  const browser = await AgentBrowser.start(undefined, process.env, undefined, ${JSON.stringify(browsers)});
  const child = (browser as any).child;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGKILL");
  await closed;
  try { await browser.close(); } finally { rmSync(browser.directory, { recursive: true, force: true }); }
});
`);
  try {
    const checks = join(work, "data", "checks", "task-1");
    const [run] = await runChecks(work, [{ name: "Tests", argv: [process.execPath, TEST_RUNNER, "./shutdown.test.ts"] }], { ...process.env, PATH: bin }, 60_000 * SLOW, undefined, checks);
    expect(run!.ok).toBe(false);
    expect(dirname(run!.logPath!)).toBe(checks);
    const log = readFileSync(run!.logPath!, "utf8");
    expect(log).toContain("PARALLEL");
    expect(log).toContain("(fail) stops a browser whose helper was killed");
    // The error stays plain; the note is its own whole line, printed once.
    expect(log).toContain("error: The headless browser did not stop.\n");
    const notes = log.split("\n").filter((line) => line.includes(CLEANUP_NOTE));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern("stage=exited-before-close elapsed=? helper=signal-SIGKILL,closed,unused early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));
  } finally { removeDir(work); }
}, 60_000 * SLOW);
