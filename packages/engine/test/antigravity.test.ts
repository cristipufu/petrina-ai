import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { readAntigravityUsage } from "@petrina/agent-runtime/antigravity-usage";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { checkAgentTool } from "@petrina/agent-runtime/probe";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { Engine } from "./engine.js";
import type { UsageLimited } from "@petrina/agent-runtime/failures";
import { Fakes, removeDir, tempDir, waitFor, SLOW } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const folder = () => { const path = tempDir("petrina-antigravity-"); roots.push(path); return path; };
const fake = join(import.meta.dir, "fake-agent.ts");
const profile = ENGINE_PROFILES.find(p => p.id === "flash-medium")!;
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };
import { quota } from "../../agent-runtime/test/fixtures/antigravity-quota.js";

describe("Antigravity native accounting", () => {
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
  it("does not send account commands after exit or wait for the account deadline when the process dies mid-read", async () => {
    const dir = folder(); new Fakes(dir);
    const run = await AgentRun.start({ profile, cwd: folder(), command: [process.execPath, fake, dir, "--tool=antigravity"], signal: new AbortController().signal, browser: false, callbacks });
    const child = run["child"], connection = run["connection"];
    const listeners = child.listenerCount("exit");
    const prompt = spyOn(connection, "prompt").mockImplementation(() => { child.kill("SIGKILL"); return new Promise(() => {}); });
    try {
      const reading = run.readAccountUsage();
      let finished = false; void reading.then(() => { finished = true; });
      await waitFor(() => finished, "account read to finish when its process exits", 5000);
      expect(await reading).toBeUndefined();
      expect(child.listenerCount("exit")).toBeLessThanOrEqual(listeners);
      prompt.mockClear();
      expect(await run.readAccountUsage()).toBeUndefined();
      expect(prompt).not.toHaveBeenCalled();
    } finally { prompt.mockRestore(); await run.stop(); }
  });

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
      const saved = join(dir, "conversations", `${sessionId}.json`);
      const conversation = JSON.parse(readFileSync(saved, "utf8"));
      // Reopening must replace the mode retained by an earlier native session too.
      conversation.options.find((option: { id: string }) => option.id === "mode").currentValue = "auto_edit";
      writeFileSync(saved, JSON.stringify(conversation));
      run = await AgentRun.start({ ...options, reopen: sessionId });
      expect(run.reopened).toBe("resume");
      expect((await run.prompt("You are the Researcher in Petrina. Hand back updated notes.")).report).toEqual({ main: { total: 110, output: 10, reasoning: 0 } });
      expect(messages.join(" ")).not.toContain("Session total");
      expect(fakes.prompts()).toHaveLength(2);
      const settings = readFileSync(join(dir, "config.jsonl"), "utf8");
      // New and resumed sessions both replace the native default with unattended mode.
      expect(settings.split("\n").filter(line => line.includes('"configId":"mode"') && line.includes('"value":"yolo"'))).toHaveLength(2);
      expect(settings).not.toContain('"value":"auto_edit"');
    } finally { await run.stop(); }
  });

  it("refuses an unconfirmed profile before sending work, and login checks never send an AI prompt", async () => {
    const dir = folder(); const fakes = new Fakes(dir);
    const command = [process.execPath, fake, dir, "--tool=antigravity"];
    await expectRejection(AgentRun.start({ profile: { ...profile, modelId: "not-available" }, cwd: folder(), command, signal: new AbortController().signal, browser: false, callbacks }), "did not confirm");
    const result = await checkAgentTool({ adapter: ADAPTERS.antigravity!, profile, cwd: folder(), command, env: process.env, which: () => null });
    expect(result.status).toBe("ready");
    expect(fakes.prompts()).toEqual([]);
  });

  it("shares account refreshes with Analytics and keeps the reported model scopes", async () => {
    const dir = folder();
    const command = [process.execPath, fake, dir, "--tool=antigravity"];
    const engine = new Engine(folder(), { agentCommand: () => [], usageCommands: { antigravity: command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.windowState().pool.usageReads?.antigravity?.state === "reported", "Antigravity's account reading");
      const before = engine.windowState().pool.usage!.filter(r => r.toolId === "antigravity");
      for (let n = 0; n < 3; n++) engine.usage({ view: "analytics", period: "today" });
      await engine.usageCoordinator.readers.get("antigravity")!.refresh(60_000);
      expect(readFileSync(join(dir, "native-usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(before).toHaveLength(3);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.some(t => t.toolId === "antigravity")).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it("delivers each native account command as one complete snapshot rather than partial window updates", async () => {
    const dir = folder(); new Fakes(dir);
    const account = spyOn({ read(_reports: readonly unknown[]) {} }, "read");
    const partial = spyOn({ read(_report: unknown) {} }, "read");
    const run = await AgentRun.start({ profile, cwd: folder(), command: [process.execPath, fake, dir, "--tool=antigravity"], signal: new AbortController().signal, browser: false, callbacks: { ...callbacks, onUsage: partial, onAccountUsage: account } });
    try {
      expect(account).toHaveBeenCalledTimes(1);
      expect(account.mock.calls[0]![0]).toHaveLength(3);
      await run.readAccountUsage();
      expect(account).toHaveBeenCalledTimes(2);
      expect(partial).not.toHaveBeenCalled();
    } finally { await run.stop(); }
  });

  it("does not replace account quotas with an interrupted native reading even if it emitted valid windows", async () => {
    const dir = folder(); new Fakes(dir);
    let snapshots = 0;
    const run = await AgentRun.start({ profile, cwd: folder(), command: [process.execPath, fake, dir, "--tool=antigravity"], signal: new AbortController().signal, browser: false, callbacks: { ...callbacks, onAccountUsage: () => { snapshots++; } } });
    const prompt = spyOn(run["connection"], "prompt").mockImplementation(async () => {
      run["state"].accountText = quota;
      return { stopReason: "cancelled" };
    });
    try {
      expect(snapshots).toBe(1);
      expect(await run.readAccountUsage()).toBeUndefined();
      expect(snapshots).toBe(1);
    } finally { prompt.mockRestore(); await run.stop(); }
  });

  it("stops a native account command that never answers", async () => {
    const dir = folder();
    let pid: number | undefined;
    await readAntigravityUsage({ command: [process.execPath, fake, dir, "--tool=antigravity", "--usage-hang"], cwd: folder(), env: process.env, timeoutMs: 1500 * SLOW, onProcess: child => { pid = child.pid; } }).catch(() => []);
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, "the unanswered account command to stop", 5000);
  });
});
