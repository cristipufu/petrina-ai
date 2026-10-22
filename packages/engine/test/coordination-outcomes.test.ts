import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it } from "bun:test";
import { linkSync, mkdirSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun } from "@petrina/core";
import { Engine } from "./engine.js";
import { EngineClient } from "../src/engine-client.js";
import { Coordination, type Result } from "../src/coordination.js";
import { matchesCheckLogIdentity } from "../src/check-log-read.js";
import { CHECK_EXIT_UNREPORTED, runChecks } from "../src/checks.js";
import { mcpRequest, mcpTools } from "../src/mcp.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { CLI, engineEnv, removeDir, tempDir, SLOW } from "./support.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});
const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] };

it("matches saved diagnostic identities without rounding large device and inode values", () => {
  const expected = { device: "9007199254740993", inode: "18446744073709551614" };
  const actual = { dev: 9007199254740993n, ino: 18446744073709551614n };
  expect(String(Number(expected.device))).not.toBe(expected.device);
  expect(matchesCheckLogIdentity(expected, actual)).toBe(true);
  expect(matchesCheckLogIdentity({ ...expected, inode: "18446744073709551613" }, actual)).toBe(false);
});

it("MCP discovery does not describe consequential controls as additive-only or closed-world", () => {
  const tools = mcpTools();
  for (const name of ["inbox_approve", "inbox_recovery", "product_checks", "product_settings", "task_source", "screen_set", "screen_task", "screen_allow", "engine_stop", "engine_restart", "engine_resume", "learning_accept"]) {
    const tool = tools.find((tool) => tool.name === `petrina_${name}`)!;
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations).not.toHaveProperty("destructiveHint", false);
    expect(tool.annotations).not.toHaveProperty("openWorldHint", false);
    expect(tool.annotations.idempotentHint).toBe(true);
    expect(tool.inputSchema.required).toContain("requestId");
  }
  for (const name of ["task_inspect", "inbox_list", "journey_check"]) {
    expect(tools.find((tool) => tool.name === `petrina_${name}`)!.annotations.readOnlyHint).toBe(true);
  }
});

function fixture() {
  const home = tempDir("petrina-coordination-outcomes-");
  roots.push(home);
  const engine = new Engine(home, options);
  engines.push(engine);
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  engine.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "product", title: "Inspect outcomes" }))!;
  return { home, engine, task, coordination: new Coordination(engine) };
}

function interfaceClient(kind: "cli" | "mcp", home: string) {
  const client = new EngineClient(home, () => { throw new Error("coordination cannot launch"); });
  return async (name: string, args: Record<string, unknown>, expectedCode = 0): Promise<Result> => {
    if (kind === "mcp") {
      const response = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `petrina_${name.replaceAll(".", "_")}`, arguments: args } }, client);
      const result = response!.result as { isError: boolean; structuredContent: Result };
      expect(result.isError).toBe(expectedCode !== 0);
      return result.structuredContent;
    }
    const argv = name.split(".");
    for (const [key, value] of Object.entries(args)) argv.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, typeof value === "string" ? value : JSON.stringify(value));
    const child = Bun.spawn([process.execPath, CLI, ...argv, "--json"], { env: engineEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(expectedCode);
    return JSON.parse(out);
  };
}

async function createdFailure(home: string, taskId: string, text: string): Promise<CheckRun> {
  const payload = join(home, "check-output.txt");
  writeFileSync(payload, text);
  try {
    const source = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(payload)})); process.exit(1)`;
    const [run] = await runChecks(home, [{ name: "Check", argv: [process.execPath, "-e", source] }], process.env, 10_000, undefined, join(home, "checks", taskId));
    return run!;
  } finally {
    unlinkSync(payload);
  }
}

for (const kind of ["cli", "mcp"] as const) {
  it(`${kind} refuses a hard-linked connection file and preserves ordinary logs, symbolic-link refusal and paginated saved explanations`, async () => {
    const { home, engine, task } = fixture();
    const directory = join(home, "checks", task.id);
    mkdirSync(directory, { recursive: true });
    const saved = "Ordinary failure note\n" + "Additional saved explanation\n".repeat(1000);
    const run = await createdFailure(home, task.id, saved);
    run.output = saved;
    const logPath = run.logPath!;
    executionFor(task).work.checks = { at: 1, results: [run] };
    task.journey = [{ id: "recorded-check", kind: "petrina", work: "checks", startedAt: 1, endedAt: 2, round: 1, sub: 0, productChecks: [{ name: run.name, result: "fail", run }] }];
    const token = "hard-link-test-connection-key-123";
    const server = serve(engine, { port: 0, token });
    const connection = { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token };
    writeConnection(home, connection);
    const call = interfaceClient(kind, home);
    try {
      unlinkSync(logPath);
      linkSync(join(home, "engine.json"), logPath);
      // The connection is replaced atomically during ordinary startup/restart. The alias then
      // has one link, so link-count checks alone accept the old connection file as a check log.
      writeConnection(home, connection);
      for (const nodeId of [undefined, "recorded-check"]) {
        const args = { taskId: task.id, index: 0, ...(nodeId ? { nodeId } : {}) };
        let page = await call("journey.check", args);
        expect(JSON.stringify(page).includes(token)).toBe(false);
        expect(page.completeness).toBe("missing-file");
        expect(page.commandOutcome).toBe("failed");
        const savedResult = page.savedResult as Result;
        let text = String(page.text);
        while (page.next) {
          page = await call("journey.check", { ...args, cursor: page.next });
          expect(JSON.stringify(page).includes(token)).toBe(false);
          text += page.text;
        }
        expect(text).toBe(saved);
        text = String(savedResult.text);
        let next = savedResult.next;
        while (next) {
          page = await call("journey.check", { ...args, section: "result", cursor: next });
          expect(JSON.stringify(page).includes(token)).toBe(false);
          text += page.text;
          next = page.next;
        }
        expect(text).toBe(saved);
      }
      // Removing the original name also leaves the alias alone. Restore discovery with
      // a new file so both interfaces can read the still-running temporary engine.
      unlinkSync(logPath);
      linkSync(join(home, "engine.json"), logPath);
      unlinkSync(join(home, "engine.json"));
      writeConnection(home, connection);
      for (const nodeId of [undefined, "recorded-check"]) {
        const page = await call("journey.check", { taskId: task.id, index: 0, ...(nodeId ? { nodeId } : {}) });
        expect(JSON.stringify(page)).not.toContain(token);
        expect(page.completeness).toBe("missing-file");
        expect(page.commandOutcome).toBe("failed");
        expect(page.text).toBe(saved.slice(0, 8000));
      }
      unlinkSync(logPath);
      symlinkSync(join(home, "engine.json"), logPath);
      const symbolic = await call("journey.check", { taskId: task.id, index: 0 });
      expect(JSON.stringify(symbolic).includes(token)).toBe(false);
      expect(symbolic.completeness).toBe("missing-file");
      expect(symbolic.text).toBe(saved.slice(0, 8000));
      unlinkSync(logPath);
      const ordinary = "Original ordinary diagnostic\n".repeat(500);
      const fresh = await createdFailure(home, task.id, ordinary);
      run.logPath = fresh.logPath;
      run.logFileIdentity = fresh.logFileIdentity;
      let page = await call("journey.check", { taskId: task.id, index: 0 });
      expect(page.completeness).toBe("complete");
      let text = String(page.text);
      while (page.next) { page = await call("journey.check", { taskId: task.id, index: 0, cursor: page.next }); text += page.text; }
      expect(text).toBe(ordinary);
      expect(text.includes(token)).toBe(false);
    } finally { server.stop(true); }
  });

  it(`${kind} rejects stale saved-explanation continuations without returning a fresh partial page`, async () => {
    const { home, engine, task } = fixture();
    const directory = join(home, "checks", task.id);
    mkdirSync(directory, { recursive: true });
    const logPath = join(directory, "empty.log");
    writeFileSync(logPath, "");
    const run: CheckRun = { name: "Check", command: "stand-in", ok: false, ms: 1, output: "", logComplete: false };
    executionFor(task).work.checks = { at: 1, results: [run] };
    const token = "stale-explanation-key-12345678901";
    const server = serve(engine, { port: 0, token });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
    const call = interfaceClient(kind, home);
    try {
      for (const source of ["empty", "missing", "legacy"]) {
        run.logPath = source === "empty" ? logPath : source === "missing" ? join(directory, "missing.log") : undefined;
        run.output = "Original saved explanation\n".repeat(100);
        const args = { taskId: task.id, index: 0, limit: 40 };
        const first = await call("journey.check", args);
        expect(first.shortened).toBe(true);
        const continued = await call("journey.check", { ...args, cursor: first.next });
        expect(continued.text).toBe(run.output.slice(40, 80));
        const savedNext = (first.savedResult as Result).next;
        run.output = "Changed saved explanation\n".repeat(100);
        for (const read of [{ ...args, cursor: first.next }, { ...args, section: "result", cursor: savedNext }]) {
          const changed = await call("journey.check", read, 5);
          expect(changed.outcome).toBe("changed");
          expect(changed.message).toContain("changed");
          expect(changed.message).toContain("beginning");
          expect(changed).not.toHaveProperty("text");
          expect(changed).not.toHaveProperty("next");
          expect(changed).not.toHaveProperty("savedResult");
        }
        expect((await call("journey.check", args)).text).toBe(run.output.slice(0, 40));
      }
    } finally { server.stop(true); }
  });

  it(`${kind} rejects log shortcuts and replaced-file continuations while preserving ordinary logs and excerpts`, async () => {
    const { home, engine, task } = fixture();
    const directory = join(home, "checks", task.id);
    mkdirSync(directory, { recursive: true });
    const log = "Original diagnostic near the beginning\n" + "Remaining diagnostic line\n".repeat(10);
    const run = await createdFailure(home, task.id, log);
    run.output = "Saved ordinary failure excerpt";
    const logPath = run.logPath!;
    const timestamp = new Date("2020-01-01T00:00:00Z");
    utimesSync(logPath, timestamp, timestamp);
    executionFor(task).work.checks = { at: 1, results: [run] };
    const token = "private-test-connection-key-12345";
    const server = serve(engine, { port: 0, token });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
    const call = interfaceClient(kind, home);
    try {
      const args = { taskId: task.id, index: 0, limit: 40 };
      const first = await call("journey.check", args);
      expect(first.text).toBe(log.slice(0, 40));
      renameSync(logPath, join(directory, "retired.log"));
      symlinkSync(join(home, "engine.json"), logPath);
      const linkedDirectory = join(directory, "shortcut");
      symlinkSync(home, linkedDirectory, "dir");
      const insideLink = join(directory, "inside-link.log");
      symlinkSync(join(directory, "retired.log"), insideLink);
      for (const location of [logPath, join(linkedDirectory, "engine.json"), insideLink]) {
        run.logPath = location;
        const unavailable = await call("journey.check", args);
        expect(unavailable.completeness).toBe("missing-file");
        expect(unavailable.text).toBe(run.output);
        expect(JSON.stringify(unavailable).includes(token)).toBe(false);
        const stale = await call("journey.check", { ...args, cursor: first.next }, 5);
        expect(stale.outcome).toBe("changed");
        expect(stale.message).toContain("beginning");
        expect(stale).not.toHaveProperty("savedResult");
        expect(JSON.stringify(stale).includes(token)).toBe(false);
      }
      unlinkSync(logPath);
      const fresh = await createdFailure(home, task.id, log);
      renameSync(fresh.logPath!, logPath);
      utimesSync(logPath, timestamp, timestamp);
      run.logPath = logPath;
      run.logFileIdentity = fresh.logFileIdentity;
      // Same name, length and timestamp; a new physical file still needs a fresh read.
      expect((await call("journey.check", { ...args, cursor: first.next }, 5)).outcome).toBe("changed");
      let page = await call("journey.check", args), full = String(page.text);
      while (page.next) { page = await call("journey.check", { ...args, cursor: page.next }); full += page.text; }
      expect(full).toBe(log);
    } finally { server.stop(true); }
  });

  it(`${kind} reports rejected starting points, preserves the previous source and replays the saved rejection`, async () => {
    const { home, engine, task, coordination } = fixture();
    engine.s.inbox.push({ id: "plan", taskId: task.id, kind: "plan", title: "Review the plan", at: 1, blocking: false });
    const server = serve(engine, { port: 0, token: "source-validation-key-12345678901" });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token: "source-validation-key-12345678901" });
    const call = interfaceClient(kind, home);
    const choice = { productId: "product", startFrom: { kind: "default" }, delivery: "local" };
    try {
      expect((await call("task.source", { taskId: task.id, choice, requestId: "valid-source" })).outcome).toBe("completed");
      const source = structuredClone(executionFor(task).work.source);
      const inspected = await coordination.call("inbox.inspect", { itemId: "plan" });
      const invalid = { taskId: task.id, choice: { ...choice, startFrom: { kind: "branch", name: "bad..branch" } }, requestId: "invalid-source" };
      const rejected = await call("task.source", invalid, 2);
      expect(rejected.outcome).toBe("invalid");
      expect(rejected.message).toBe(task.workError!);
      expect(rejected.message).toContain("valid branch name");
      expect(executionFor(task).work.source).toEqual(source);
      expect(task.proposedSource).toBeUndefined();
      expect(engine.s.inbox.map((item) => item.id)).toContain("plan");
      expect((await coordination.call("inbox.approve", { itemId: "plan", revision: inspected.revision, requestId: "stale-approval" })).outcome).toBe("changed");
      expect((await call("task.source", { taskId: task.id, choice, requestId: "correct-source" })).outcome).toBe("completed");
      expect(task.workError).toBeUndefined();
      expect(await call("task.source", invalid, 2)).toEqual(rejected);
      expect(task.workError).toBeUndefined();
      expect((await call("task.source", { ...invalid, choice }, 5)).outcome).toBe("conflict");
      expect(executionFor(task).work.source).toEqual(source);
      for (const [index, other] of [
        { ...choice, productId: "unregistered-product" },
        { ...choice, startFrom: { kind: "branch", name: "main" }, delivery: "release" },
      ].entries()) {
        const rejected = await call("task.source", { taskId: task.id, choice: other, requestId: `other-rejection-${index}` }, 2);
        expect(rejected.outcome).toBe("invalid");
        expect(rejected.message).toBe(task.workError!);
        expect(executionFor(task).work.source).toEqual(source);
      }
      if (kind === "cli") {
        const child = Bun.spawn([process.execPath, CLI, "task", "source", task.id, "--choice", JSON.stringify(invalid.choice), "--request-id", "human-rejection"], { env: engineEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect(code).toBe(2);
        expect(out).toContain("Outcome: invalid");
        expect(out).toContain("valid branch name");
      }
      engine.s.inbox = [];
      expect((await call("task.source", { taskId: task.id, choice, requestId: "no-plan-checkpoint" }, 2)).message).toContain("plan check before work starts");
    } finally { server.stop(true); }
  });

  it(`${kind} reads saved startup failures beside real process output, including historical evidence after restart`, async () => {
    const { home, engine, task } = fixture();
    const runs = await runChecks(home, [
      { name: "Missing", argv: [join(home, "no-such-check")] },
      { name: "Failed", argv: [process.execPath, "-e", 'console.error("Error printed by the check"); process.exit(1)'] },
      { name: "Quiet", argv: [process.execPath, "-e", "process.exit(0)"] },
    ], engineEnv(home), 10000 * SLOW, undefined, join(home, "checks", task.id));
    expect(typeof runs[0]!.logFileIdentity?.device).toBe("string");
    expect(typeof runs[0]!.logFileIdentity?.inode).toBe("string");
    expect(runs[0]!.output).toContain("Could not start:");
    executionFor(task).work.checks = { at: 1, sha: "original", results: runs };
    task.journey = [{ id: "original-checks", kind: "petrina", work: "checks", startedAt: 1, endedAt: 2, round: 1, sub: 0, productChecks: runs.map((run) => ({ name: run.name, result: run.ok ? "pass" : "fail", run })) }];
    const token = "check-outcome-key-123456789012345";
    let server = serve(engine, { port: 0, token });
    const connect = () => writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
    connect();
    const call = interfaceClient(kind, home);
    try {
      for (const nodeId of [undefined, "original-checks"]) {
        const read = (index: number) => call("journey.check", { taskId: task.id, index, ...(nodeId ? { nodeId } : {}) });
        const missing = await read(0);
        expect(missing.text).toBe(runs[0]!.output);
        expect(missing.commandOutcome).toBe("failed");
        expect(missing.completeness).toBe("incomplete");
        expect(missing.source).toBe("saved-result");
        expect(missing.savedResult).toHaveProperty("text", runs[0]!.output);
        const failed = await read(1);
        expect(failed.text).toBe("Error printed by the check\n");
        expect(failed.commandOutcome).toBe("failed");
        expect(failed.completeness).toBe("complete");
        const quiet = await read(2);
        expect(quiet.text).toBe("");
        expect(quiet.commandOutcome).toBe("passed");
        expect(quiet.completeness).toBe("complete");
      }
      executionFor(task).work.checks = { at: 3, sha: "later", results: [runs[2]!] };
      task.state = "paused";
      server.stop(true);
      await engine.shutdown();
      const restarted = new Engine(home, { ...options, admissionsClosed: true });
      engines.push(restarted);
      server = serve(restarted, { port: 0, token });
      connect();
      const original = await call("journey.check", { taskId: task.id, nodeId: "original-checks", index: 0 });
      expect(original.text).toBe(runs[0]!.output);
      expect(original.commandOutcome).toBe("failed");
      expect(original.relevance).toBe("historical");
    } finally { server.stop(true); }
  });
}

it("labels older check logs without creation identity as unverified and uses only their saved excerpt", async () => {
  const { home, task, coordination } = fixture();
  const directory = join(home, "checks", task.id);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "older.log");
  const saved = "The failure excerpt saved with this older run.";
  writeFileSync(logPath, "Unverified raw file content");
  executionFor(task).work.checks = { at: 1, results: [{ name: "Check", command: "stand-in", ok: false, ms: 1, output: saved, logPath, logComplete: true }] };
  const result = await coordination.call("journey.check", { taskId: task.id, index: 0 });
  expect(result.completeness).toBe("legacy-unverified");
  expect(result.text).toBe(saved);
  expect(result.text).not.toContain("Unverified raw file content");
  expect(result.message).toContain("no record of which file Petrina created");
});

it("paginates legacy saved failure details independently of a long or empty process log", async () => {
  const { home, task, coordination } = fixture();
  const directory = join(home, "checks", task.id);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "recorded.log");
  const saved = "Could not finish: saved explanation\n" + "Additional recorded details\n".repeat(1000);
  const run: CheckRun = { name: "Check", command: "stand-in", ok: false, ms: 1, output: saved, logPath, logComplete: false };
  executionFor(task).work.checks = { at: 1, results: [run] };
  for (const log of ["", "Original process output\n".repeat(2000)]) {
    writeFileSync(logPath, log);
    let page = await coordination.call("journey.check", { taskId: task.id, index: 0, limit: 100 });
    expect(String(page.text).length).toBeLessThanOrEqual(100);
    const savedResult = page.savedResult as Result;
    expect(String(savedResult.text).length).toBeLessThanOrEqual(100);
    expect(savedResult.shortened).toBe(true);
    expect(savedResult.section).toBe("result");
    let full = String(savedResult.text), next = savedResult.next;
    while (next) {
      page = await coordination.call("journey.check", { taskId: task.id, index: 0, section: "result", cursor: next });
      full += page.text;
      next = page.next;
    }
    expect(full).toBe(saved);
    if (!log) {
      page = await coordination.call("journey.check", { taskId: task.id, index: 0, limit: 100 });
      full = String(page.text);
      while (page.next) { page = await coordination.call("journey.check", { taskId: task.id, index: 0, cursor: page.next }); full += page.text; }
      expect(full).toBe(saved);
    }
    run.output = "Changed recorded explanation";
    expect((await coordination.call("journey.check", { taskId: task.id, index: 0, section: "result", cursor: savedResult.next })).outcome).toBe("changed");
    run.output = saved;
  }
});

for (const kind of ["cli", "mcp"] as const) it(`${kind} inspects compact checkpoints and follows only the selected saved diagnostics`, async () => {
  const { home, engine, task } = fixture();
  const work = executionFor(task).work;
  const results = ["Types", "Build", "Tests", "Shell"].map((name) => ({ name, command: `check ${name}`, ok: true, ms: 1, output: "Successful output\n".repeat(1000) }));
  work.checks = { at: 1, sha: "recorded", tree: "tree", definition: "definition", current: true, results };
  const itemId = `compact-${kind}`;
  engine.s.inbox.push({ id: itemId, taskId: task.id, kind: "delivery", title: "Inspect the delivery", body: "The actual checkpoint request", at: 2, blocking: false });
  const token = "compact-checkpoint-key-1234567890123";
  const server = serve(engine, { port: 0, token });
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  const call = interfaceClient(kind, home);
  try {
    const page = await call("inbox.inspect", { itemId });
    expect(page.shortened).toBe(false);
    expect(page.decisions).toEqual(["inbox.approve", "inbox.changes"]);
    expect(page.revision).toBeString();
    expect(String(page.text)).not.toContain("Successful output");
    const view = JSON.parse(String(page.text));
    expect(view.request.body).toBe("The actual checkpoint request");
    expect(view.products[0].checks.results).toHaveLength(4);
    const { operation, ...args } = view.products[0].checks.results[2].diagnostics.read;
    const diagnostic = await call(operation, { ...args, section: "result", limit: 100 });
    expect(diagnostic.commandOutcome).toBe("passed");
    expect(diagnostic.text).toBe(results[2]!.output.slice(0, 100));
    work.checks.results = [{ ...results[2]!, ok: false, output: "A failure to start was saved separately" }];
    const changed = await call(operation, { ...args, section: "result" }, 5);
    expect(changed.outcome).toBe("changed");
    expect(changed.text).toBeUndefined();
    const failed = await call("inbox.inspect", { itemId });
    expect(failed.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
    expect(JSON.parse(String(failed.text)).products[0].checks.results[0].diagnostics.savedResult.text).toBe("A failure to start was saved separately");
    work.checks.results[0]!.output = "é" + "🙂".repeat(3000) + "\n" + CHECK_EXIT_UNREPORTED;
    const unknown = await call("inbox.inspect", { itemId });
    expect(unknown.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
    const check = JSON.parse(String(unknown.text)).products[0].checks.results[0];
    expect(check.commandOutcome).toBe("unknown");
    expect(check.exitUnreported).toBe(true);
    for (const preview of [check.diagnostics.savedResult, check.diagnostics.savedResultEnding])
      expect(preview.text).toBe(Buffer.from(preview.text).toString("utf8"));
    expect(check.diagnostics.savedResultEnding.text).toContain(CHECK_EXIT_UNREPORTED);
    const { operation: savedOperation, ...savedArgs } = check.diagnostics.savedResultRead;
    const continued = await call(savedOperation, { ...savedArgs, cursor: check.diagnostics.savedResult.next });
    expect(check.diagnostics.savedResult.text + continued.text).toBe(work.checks.results[0]!.output);
  } finally { server.stop(true); }
});
