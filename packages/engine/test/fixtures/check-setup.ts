import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { checksFor } from "@petrina/repositories/check-discovery";
import { repositorySeed } from "@petrina/test-support/repositories";
import { createLeasedProgramRecords, type LeasedProgramRecords } from "@petrina/test-support/leased-program-records";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { tempDir } from "../fixtures.js";
import { directDrivers } from "./direct-drivers.js";
import { commandInputText } from "../../src/checks.js";

export interface SetupCommand {
  code?: number;
  stdout?: string;
  stderr?: string;
  mark?: string;
  release?: string;
  writeTracked?: { file: string; text: string };
}

/** A real check owner with private Git/SQLite and leased argv actors; no planning or agent workflow. */
export async function checkSetupFixture() {
  const root = tempDir("check-setup-");
  const owners = directDrivers(root);
  let programs: LeasedProgramRecords | undefined, closing: Promise<void> | undefined;
  let controller = new AbortController();
  const close = () => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void (async () => {
    controller.abort();
    const results = await Promise.allSettled([
      owners.prepare(async () => { await programs?.close(); }),
    ]);
    const stopped = await Promise.allSettled([owners.close()]);
    const failures = [...results, ...stopped].filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Check setup fixture cleanup was not confirmed");
    })().then(resolve, reject);
    return closing;
  };
  return setupWithCleanup(() => owners.prepare(async () => {
    programs = await createLeasedProgramRecords(join(root, "actors"));
    const config = join(root, "commands.json"), log = join(root, "invocations.jsonl");
    writeFixtureJson(config, {});
    const script = programs.write("check.ts", "local-check", () => `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [kind] = process.argv.slice(2);
const config = join(import.meta.dir, "..", "commands.json"), log = join(import.meta.dir, "..", "invocations.jsonl");
const choice = JSON.parse(readFileSync(config, "utf8"))[kind] ?? {};
appendFileSync(log, JSON.stringify({ kind, pid: process.pid }) + "\\n");
if (choice.mark) writeFileSync(choice.mark, "ready");
if (choice.release) while (!existsSync(choice.release)) await Bun.sleep(10);
if (choice.writeTracked) writeFileSync(choice.writeTracked.file, choice.writeTracked.text);
if (choice.stdout !== undefined) process.stdout.write(choice.stdout);
if (choice.stderr !== undefined) process.stderr.write(choice.stderr);
process.exit(choice.code ?? 0);`);
    const data = join(root, "data"), path = join(root, "repository"), seed = await repositorySeed();
    cpSync(seed.clone, path, { recursive: true });
    const start = () => owners.open(data, { agentCommand: () => undefined, terminals: () => [] });
    let engine = start();
    engine.schedule = () => engine.checkQueue.pump();
    await engine.waitUntilReady();
    engine.s.products.push({ id: "product", name: "Product", path, repo: "local/product", tone: "blue" });
    const taskId = engine.addTask({ productId: "product", title: "Verify local setup", backlog: true });
    const task = engine.task(taskId)!;
    task.repository = { productId: "product", worktree: path, base: seed.head, baseSha: seed.head, branch: "main", delivery: "local" };
    task.plan = { rationale: "Only the local verification boundary", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
      { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
    ] };
    task.stageIndex = 1; task.state = "running";
    engine.setPoolPaused(false);
    let commands: Record<string, SetupCommand> = {};
    const argv = (kind: string) => [process.execPath, script, kind];
    const current = () => executionFor(engine.task(taskId)!);
    const run = (lowLevel = false) => {
      const actual = engine, scope = current(), stopped = controller.signal;
      return owners.run(actual, () => lowLevel
        ? actual["checks"].runProductChecks(scope, checksFor(actual.s.products.find(product => product.id === "product")!, path), stopped)
        : actual["checks"].failing(scope, stopped));
    };
    return {
      root, path, data, taskId, script, argv, owners,
      get engine() { return engine; },
      get scope() { return current(); },
      get task() { return engine.task(taskId)!; },
      get product() { return engine.s.products.find(product => product.id === "product")!; },
      command(kind: string, choice: SetupCommand) { commands = { ...commands, [kind]: { ...choice } }; writeFixtureJson(config, commands); },
      setChecks(kinds: readonly string[]) {
        if (!kinds.length) { engine.s.products.find(product => product.id === "product")!.checks = []; engine.s.products.find(product => product.id === "product")!.checksBy = "coordinator"; }
        else engine.setProductChecks("product", kinds.map(kind => ({ name: kind, command: commandInputText(argv(kind)) })));
      },
      setSetup(kinds: readonly string[]) { engine.setProductCheckSetup("product", kinds.map(kind => ({ id: kind, name: kind, argv: argv(kind) }))); },
      check: () => run(),
      run: () => run(true),
      native<T>(start: () => Promise<T>) { const actual = engine; return owners.run(actual, start); },
      invocations: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => (JSON.parse(line) as { kind: string }).kind) : [],
      async restart() {
        await owners.prepare(async () => {
          const old = engine;
          old.commitNow();
          controller.abort();
          await owners.stop(old);
          controller = new AbortController();
          engine = start(); engine.schedule = () => engine.checkQueue.pump();
          await engine.waitUntilReady();
          engine.setPoolPaused(false);
        });
      },
      receipts: () => programs!.records(),
      release(file: string) { writeFileSync(file, "continue"); },
      close,
    };
  }), close);
}
