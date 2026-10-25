import { expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

it("stops detached programs even when a conversation has no browser", async () => {
  const root = tempDir("petrina-text-agent-cleanup-");
  const pidFile = join(root, "child.pid");
  const wrapper = join(root, "agent.ts");
  writeFileSync(wrapper, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); child.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
await import(${JSON.stringify(join(import.meta.dir, "../../fixtures/session-agent.ts"))});`);
  let run: AgentRun | undefined;
  let pid: number | undefined;
  try {
    run = await AgentRun.start({ profile: { id: "text-only", toolId: "codex", model: "sol", effort: "high" }, cwd: root, browser: false, command: [process.execPath, wrapper], signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, async onPermission() { return "deny"; } } });
    pid = Number(readFileSync(pidFile, "utf8"));
    process.kill(pid, 0);
    await run.stop();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    await run?.stop();
    pid ??= existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined;
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    removeDir(root);
  }
});
