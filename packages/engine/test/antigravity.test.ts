import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AgentRun } from "../src/acp-run.js";
import { antigravityReading, antigravityTurnReport } from "../src/antigravity-report.js";
import { readAntigravityUsage } from "../src/antigravity-usage.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { checkAgentTool } from "../src/setup.js";
import { ADAPTERS } from "../src/tools.js";
import { Engine } from "../src/engine.js";
import type { UsageLimited } from "../src/usage.js";
import { Fakes, removeDir, tempDir, waitFor, SLOW } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const folder = () => { const path = tempDir("petrina-antigravity-"); roots.push(path); return path; };
const fake = join(import.meta.dir, "fake-agent.ts");
const profile = ENGINE_PROFILES.find(p => p.id === "flash-medium")!;
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };
const quota = `### Session Usage
- **Session total:** 26,682 tokens (prompt: 26,645, completion: 4, thinking: 33)
### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini Flash, Gemini Pro)*
  - **Weekly Limit Remaining:** 100% remaining (resets Oct 26, 2026, 16:50 UTC)
  - **Five Hour Limit Remaining:** 80% remaining (resets Oct 19, 2026, 21:50 UTC)
- **Claude and GPT models**
  - **Weekly Limit Remaining:** 0% remaining (resets Oct 26, 2026, 17:36 UTC)
- **Gemini 4 Argon**
  - **Gemini 4 Argon Weekly Limit:** 2% remaining (resets Oct 26, 2026, 17:33 UTC)`;

describe("Antigravity native accounting", () => {
  it("reads the native quota groups and explicit UTC resets, without blocking Gemini for unavailable third-party models", () => {
    const reading = antigravityReading(quota);
    expect(reading.tokens).toEqual({ total: 26682, input: 26645, output: 37, reasoning: 33 });
    expect(reading.reports).toEqual([
      { toolId: "antigravity", model: "flash", name: "Gemini Models", kind: "seven_day", utilization: 0, status: "allowed", resetsAt: Date.parse("2026-10-26T16:50Z") },
      { toolId: "antigravity", model: "flash", name: "Gemini Models", kind: "five_hour", utilization: 0.2, status: "allowed", resetsAt: Date.parse("2026-10-19T21:50Z") },
      { toolId: "antigravity", model: "argon", name: "Gemini 4 Argon", kind: "seven_day", utilization: 0.98, status: "allowed_warning", resetsAt: Date.parse("2026-10-26T17:33Z") },
    ]);
    expect(antigravityReading(quota.replace(/- \*\*Gemini 4 Argon\*\*[\s\S]*/, "")).reports[0]?.model).toBe("gemini");
    expect(antigravityReading(quota.replace("2% remaining", "0% remaining")).reports.at(-1)?.status).toBe("rejected");
    expect(antigravityReading(quota.replaceAll(/resets [^)]+/g, "resets invalid")).reports).toEqual([]);
    expect(antigravityReading("context: 500000 tokens")).toEqual({ reports: [] });
    // Native /usage reports unused shared windows alongside a separately consumed Argon quota.
    const separate = antigravityReading(quota.replace("80% remaining", "100% remaining").replace("2% remaining", "37% remaining")).reports;
    expect(separate.map(report => [report.model, report.kind, report.utilization])).toEqual([
      ["flash", "seven_day", 0], ["flash", "five_hour", 0], ["argon", "seven_day", 0.63],
    ]);
  });

  it("uses differences across turns and resume, includes thinking once in output, and leaves cache/new input unknown", () => {
    const zero = antigravityReading("- **Session total:** data not available yet");
    const first = antigravityReading(quota);
    const second = antigravityReading(quota.replace("26,682", "26,797").replace("26,645", "26,745").replace("completion: 4", "completion: 9").replace("thinking: 33", "thinking: 43"));
    expect(antigravityTurnReport(zero, first)).toEqual({ main: { total: 26682, output: 37, reasoning: 33 } });
    expect(antigravityTurnReport(first, second)).toEqual({ main: { total: 115, output: 15, reasoning: 10 } });
    expect(antigravityTurnReport(second, first)).toBeUndefined();
    expect(antigravityTurnReport(undefined, first)).toBeUndefined();
    expect(antigravityReading(quota.replace("26,682", "999" )).tokens).toBeUndefined();
  });

  it("asks only the built-in command for an account reading and stops its harness", async () => {
    const dir = folder(); const fakes = new Fakes(dir);
    let pid: number | undefined;
    const reports = await readAntigravityUsage({ command: [process.execPath, fake, dir, "--tool=antigravity"], cwd: folder(), env: process.env, onProcess: child => { pid = child.pid; } });
    expect(reports).toHaveLength(3);
    expect(fakes.prompts()).toEqual([]);
    expect(readFileSync(join(dir, "native-usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    await waitFor(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, "the Antigravity account process to exit", 5000);
  });
});

describe("Antigravity agent sessions", () => {
  it("hands an exhausted Argon profile back through the usage path without blocking Flash", async () => {
    const dir = folder(); const fakes = new Fakes(dir);
    const options = { cwd: folder(), command: [process.execPath, fake, dir, "--tool=antigravity", "--argon-empty"], signal: new AbortController().signal, browser: false, callbacks };
    const argon = await AgentRun.start({ ...options, profile: ENGINE_PROFILES.find(p => p.id === "argon-high")! });
    try {
      const error = await argon.prompt("You are the Researcher in Petrina. Hand back notes.").then(() => undefined, error => error as UsageLimited);
      expect(error).toMatchObject({ toolId: "antigravity", model: "argon" });
      expect(error?.until).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect(fakes.prompts()).toHaveLength(0);
    } finally { await argon.stop(); }
    const flash = await AgentRun.start({ ...options, profile });
    try { expect((await flash.prompt("You are the Researcher in Petrina. Hand back notes.")).report?.main?.total).toBe(110); }
    finally { await flash.stop(); }
  });
  it("removes only its disposable probe database after the harness exits", async () => {
    const home = folder();
    const run = await AgentRun.start({ profile, cwd: folder(), env: { ...process.env, GEMINI_HOME: home }, command: [process.execPath, fake, "--tool=antigravity"], signal: new AbortController().signal, probe: true, callbacks });
    const dir = join(home, "antigravity-acp", "conversations");
    mkdirSync(dir, { recursive: true });
    const files = [".db", ".db-wal", ".db-shm", ".meta"].map(suffix => join(dir, `${run.sessionId}${suffix}`));
    for (const file of files) writeFileSync(file, "probe");
    const kept = join(dir, "another-conversation.db"); writeFileSync(kept, "keep");
    try { expect(files.every(existsSync)).toBe(true); }
    finally { await run.stop(); }
    expect(files.some(existsSync)).toBe(false);
    expect(readFileSync(kept, "utf8")).toBe("keep");
  });
  it("confirms model and thinking, keeps account commands out of messages, and counts only each new turn after resume", async () => {
    const dir = folder(); const fakes = new Fakes(dir); fakes.scenario({ reopen: "resume" });
    const messages: string[] = [];
    const options = { profile, cwd: folder(), command: [process.execPath, fake, dir, "--tool=antigravity"], signal: new AbortController().signal, browser: false, callbacks: { ...callbacks, onMessage: (message: { text: string }) => { messages.push(message.text); } } };
    let run = await AgentRun.start(options);
    try {
      expect(run.settings).toEqual({ model: "gemini-3.8-flash", modelName: "Gemini 3.8 Flash", effort: "medium" });
      const first = await run.prompt("You are the Researcher in Petrina. Hand back notes.");
      expect(first.report).toEqual({ main: { total: 110, output: 10, reasoning: 0 } });
      expect(first.text).not.toContain("Quota Limits");
      const sessionId = run.sessionId;
      await run.stop();
      run = await AgentRun.start({ ...options, reopen: sessionId });
      expect(run.reopened).toBe("resume");
      expect((await run.prompt("You are the Researcher in Petrina. Hand back updated notes.")).report).toEqual({ main: { total: 110, output: 10, reasoning: 0 } });
      expect(messages.join(" ")).not.toContain("Session total");
      expect(fakes.prompts()).toHaveLength(2);
      const settings = readFileSync(join(dir, "config.jsonl"), "utf8");
      expect(settings).toContain('"value":"auto_edit"');
      expect(settings).not.toContain('"value":"yolo"');
    } finally { await run.stop(); }
  });

  it("refuses an unconfirmed profile before sending work, and login checks never send an AI prompt", async () => {
    const dir = folder(); const fakes = new Fakes(dir);
    const command = [process.execPath, fake, dir, "--tool=antigravity"];
    await expect(AgentRun.start({ profile: { ...profile, modelId: "not-available" }, cwd: folder(), command, signal: new AbortController().signal, browser: false, callbacks })).rejects.toThrow("did not confirm");
    const result = await checkAgentTool({ adapter: ADAPTERS.antigravity!, profile, cwd: folder(), command, env: process.env, which: () => null });
    expect(result.status).toBe("ready");
    expect(fakes.prompts()).toEqual([]);
  });

  it("shares account refreshes with Analytics and keeps the reported model scopes", async () => {
    const dir = folder();
    const command = [process.execPath, fake, dir, "--tool=antigravity"];
    const engine = new Engine(folder(), { agentCommand: () => [], antigravityCommand: command, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.windowState().pool.usageReads?.antigravity?.state === "reported", "Antigravity's account reading");
      const before = engine.windowState().pool.usage!.filter(r => r.toolId === "antigravity");
      for (let n = 0; n < 3; n++) engine.usage({ view: "analytics", period: "today" });
      await engine.antigravityUsage!.refresh(60_000);
      expect(readFileSync(join(dir, "native-usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(before).toHaveLength(3);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.some(t => t.toolId === "antigravity")).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it("stops a native account command that never answers", async () => {
    const dir = folder();
    let pid: number | undefined;
    await readAntigravityUsage({ command: [process.execPath, fake, dir, "--tool=antigravity", "--usage-hang"], cwd: folder(), env: process.env, timeoutMs: 1500 * SLOW, onProcess: child => { pid = child.pid; } }).catch(() => []);
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, "the unanswered account command to stop", 5000);
  });
});
