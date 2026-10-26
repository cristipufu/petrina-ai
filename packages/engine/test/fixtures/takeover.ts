import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, type EngineOptions } from "../engine.js";
import { Fakes, makeProduct } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import type { CliScript } from "./takeover-cli.js";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { createLeasedProgramRecords, type LeasedProgramRecords } from "@petrina/test-support/leased-program-records";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { runCommand, type CommandResult } from "@petrina/test-support/commands";
import { FALLBACK_TIMEOUT } from "@petrina/test-support/run";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { gitCommand, writeGitProgram } from "@petrina/test-support/git-program";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { childState } from "@petrina/platform/process-tree";
import { processAlive } from "../../src/instance.js";

export const takeoverDir = (data: string, taskId: string) => join(data, "takeover", taskId);
export const LAUNCHER = process.platform === "darwin" ? "open.command" : "open.sh";

/** Real takeover composition: private Git/SQLite/ACP plus leased terminal actors; no native provider fallback. */
export function takeoverFixtures() {
  const owners: { close(): Promise<void> }[] = [];
  const start = async (scenario: Scenario, description = "", native: { launcherEnv?: Record<string, string>; observeLauncher?(pid: number, state: Awaited<ReturnType<typeof childState>>): void } = {}) => {
    const root = tempDir("petrina-takeover-"), actors = join(root, "actors"), drainedCommands = join(root, "drained-terminal-commands");
    registerFixtureRoot(root);
    const engines: Engine[] = [], copies: { result: Promise<CommandResult>; controller: AbortController }[] = [];
    let agentLease: ProcessLease | undefined, terminalActors: LeasedProgramRecords | undefined, closing: Promise<void> | undefined;
    let engine: Engine | undefined, taskId: string | undefined, openingCalls = 0;
    const actorRecords = () => terminalActors?.records() ?? [];
    const close = () => closing ??= (async () => {
      const errors: unknown[] = [];
      for (const owned of engines) try { await owned.shutdown(); } catch (error) { errors.push(error); }
      try { await terminalActors?.close(); } catch (error) { errors.push(error); }
      try { await agentLease?.close(); } catch (error) { errors.push(error); }
      const settled = await Promise.allSettled(copies.map(copy => settleCommandAfterStop({ result: copy.result, abort: () => copy.controller.abort() })));
      for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
      try {
        await waitFor(async () => {
          const records = actorRecords(), openers = records.filter(actor => actor.kind === "opener");
          if (openers.length < openingCalls || records.some(actor => actor.state !== "ended" || processAlive(actor.pid))) return false;
          // An ended status file is written before the shell's last cleanup/output and is not an exit proof.
          for (const actor of openers) {
            const resultFile = join(drainedCommands, actor.id + ".json");
            const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : undefined;
            if (result?.error) throw new Error(result.error);
            if (result?.id === actor.id && result.pid === actor.pid && Number.isSafeInteger(result.code) && result.code >= 0) continue;
            const startedFile = join(drainedCommands, actor.id + ".started.json");
            if (!existsSync(startedFile)) return false;
            const started = JSON.parse(readFileSync(startedFile, "utf8"));
            if (started.id !== actor.id || started.pid !== actor.pid || !Number.isSafeInteger(started.childPid) || started.childPid <= 0) return false;
            // Saved numbers authorize observation only; a missing/unavailable native result is not completion.
            const state = await childState(started.childPid);
            native.observeLauncher?.(started.childPid, state);
            if (state !== "ended") return false;
          }
          return true;
        }, "the independently leased terminal actors and actual launchers to end", 5_000);
      } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, `Takeover cleanup is unconfirmed; retained ${root}`);
      removeDir(root);
    })();
    owners.push({ close });
    return setupWithCleanup(async () => {
      agentLease = await createProcessLease(); terminalActors = await createLeasedProgramRecords(actors);
      mkdirSync(drainedCommands);
      const product = await makeProduct(root), data = join(root, "data"), fakes = new Fakes(join(root, "fake"));
      fakes.scenario(scenario);
      const modules = { cli: join(import.meta.dir, "takeover-cli.ts"), agent: join(import.meta.dir, "../fake-agent.ts"), json: import.meta.resolve("@petrina/test-support/fixture-json"), commands: import.meta.resolve("@petrina/test-support/commands") };
      const agent = join(root, "takeover-agent.ts");
      writeFileSync(agent, agentLease.program(`await import(${JSON.stringify(modules.agent)}); await new Promise(() => undefined);`));
      const cliActor = terminalActors.write("takeover-cli.ts", "cli", () => `await import(${JSON.stringify(modules.cli)});`);
      const opener = terminalActors.write("takeover-opener.ts", "opener", identity => `
const { existsSync } = await import("node:fs");
const { writeFixtureJson } = await import(${JSON.stringify(modules.json)});
const { runCommand, startCommand } = await import(${JSON.stringify(modules.commands)});
const [gate, launcher] = process.argv.slice(2);
while (gate && existsSync(gate)) await Bun.sleep(30);
const resultFile = ${JSON.stringify(drainedCommands)} + "/" + ${identity}.id + ".json";
const controller = new AbortController();
let nativeLauncher;
const running = runCommand(["/bin/sh", launcher], { timeoutMs: ${FALLBACK_TIMEOUT}, signal: controller.signal, env: { ...process.env, ...${JSON.stringify(native.launcherEnv ?? {})} },
  start(argv, options) { nativeLauncher = startCommand(argv, options); return nativeLauncher; },
});
void running.catch(() => undefined);
try {
  if (!Number.isSafeInteger(nativeLauncher?.pid) || nativeLauncher.pid <= 0) throw new Error("The native launcher did not report its owned identity");
  writeFixtureJson(${JSON.stringify(drainedCommands)} + "/" + ${identity}.id + ".started.json", { ...${identity}, childPid: nativeLauncher.pid });
  const result = await running;
  // This separate evidence comes only from the canonical command's actual drained result.
  writeFixtureJson(resultFile, { ...${identity}, code: result.code });
  process.exit(result.code);
} catch (error) {
  controller.abort();
  try { await running; } catch { /* The original command failure is retained below; unknown never becomes success. */ }
  writeFixtureJson(resultFile, { ...${identity}, error: String(error) });
  throw error;
}`);
      const bin = join(root, "bin"), app = join(bin, "agent-app");
      mkdirSync(bin);
      writeGitProgram(app, `if [ "$1" = "--help" ]; then\n  printf '%s\\n' '--permission-mode <mode> (choices: "manual", "default")'\n  exit 0\nfi\nexec ${gitCommand([process.execPath, "--no-env-file", cliActor, fakes.dir])} "$@"`);
      let opening: string | undefined;
      const options: EngineOptions = {
        agentCommand: () => [process.execPath, "--no-env-file", agent, fakes.dir], toolPath: () => app,
        terminals: () => [{ id: "test", name: "Test terminal", open: launcher => { openingCalls++; return [process.execPath, "--no-env-file", opener, opening ?? "", launcher]; } }],
      };
      engine = new Engine(data, options); engines.push(engine);
      const productId = await engine.addProduct(product);
      engine.setProductDelivery(productId, "local", false);
      taskId = engine.addTask({ productId, title: "Add a greeting", description });
      const task = () => engine!.getState().tasks.find(entry => entry.id === taskId)!;
      const cli = (script: CliScript) => writeFixtureJson(join(fakes.dir, "cli.json"), script);
      const finished = () => waitFor(() => task().state === "done" ? task() : task().state === "failed" ? Promise.reject(new Error(task().error)) : undefined, "the task to finish", 90_000);
      const working = (roleId: string) => waitFor(() => task().agent?.roleId === roleId && task().conversation?.briefed && task().conversation?.roleId === roleId && task(), `the ${roleId} to be at work`);
      const restart = async () => { await engine!.shutdown(); engine = new Engine(data, options); engines.push(engine); return engine; };
      const launched = (): { args: string[]; cwd: string; env: string[] }[] => {
        const file = join(fakes.dir, "cli.jsonl");
        return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
      };
      const copy = (command: string) => {
        const controller = new AbortController();
        const result = runCommand(["/bin/sh", "-c", command], { cwd: root, signal: controller.signal, timeoutMs: FALLBACK_TIMEOUT });
        void result.catch(() => undefined); copies.push({ result, controller });
        const exited = result.then(result => result.code), stdout = result.then(result => result.stdout);
        void exited.catch(() => undefined); void stdout.catch(() => undefined);
        return { result, exited, stdout };
      };
      const launcherRecords = () => actorRecords().filter(actor => actor.kind === "opener").flatMap(actor => {
        const file = join(drainedCommands, actor.id + ".started.json");
        return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8")) as { id: string; pid: number; childPid: number }] : [];
      });
      return { root, product, data, fakes, options, taskId: taskId!, task, cli, finished, working, restart, launched, launcherRecords,
        engine: () => engine!, close, copy, actorRecords, closeTerminal: () => terminalActors!.close(), setOpening: (gate: string | undefined) => { opening = gate; } };
    }, close);
  };
  return { start, close: async () => {
    const settled = await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Takeover fixtures retained unconfirmed owners");
  } };
}

/** Independent native control: actual rm completes, then remains live while the launcher's final shell is held. */
export async function heldLauncherCleanup() {
  const root = tempDir("petrina-launcher-rm-"), gate = join(root, "hold"), ready = join(root, "ready.json");
  registerFixtureRoot(root);
  let programs: LeasedProgramRecords | undefined, closing: Promise<void> | undefined;
  const release = () => rmSync(gate, { force: true });
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    try { release(); } catch (error) { errors.push(error); }
    try { await programs?.close(); } catch (error) { errors.push(error); }
    try { await waitFor(async () => (await Promise.all((programs?.records() ?? []).map(record => childState(record.pid)))).every(state => state === "ended"), "the independent rm control to end", 5_000); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `The independent rm control could not stop; retained ${root}`);
    removeDir(root);
  })();
  return setupWithCleanup(async () => {
    programs = await createLeasedProgramRecords(join(root, "actors"));
    const realRm = Bun.which("rm");
    if (!realRm) throw new Error("This POSIX launcher contract requires rm");
    writeFileSync(gate, "");
    const commands = import.meta.resolve("@petrina/test-support/commands"), json = import.meta.resolve("@petrina/test-support/fixture-json");
    const program = programs.write("rm.ts", "rm", identity => `
const { runCommand } = await import(${JSON.stringify(commands)});
const { writeFixtureJson } = await import(${JSON.stringify(json)});
const { existsSync } = await import("node:fs");
const args = process.argv.slice(2);
const result = await runCommand([${JSON.stringify(realRm)}, ...args]);
if (result.code !== 0) process.exit(result.code);
if (args.some(arg => /^run\\.\\d+$/.test(arg.split("/").at(-1)))) {
  writeFixtureJson(${JSON.stringify(ready)}, ${identity});
  while (existsSync(${JSON.stringify(gate)})) await Bun.sleep(10);
}
process.exit(0);`);
    writeGitProgram(join(root, "rm"), `exec ${gitCommand([process.execPath, "--no-env-file", program])} "$@"`);
    return { root, release, close, launcherEnv: { PATH: `${root}:${process.env.PATH ?? ""}` },
      ready: () => existsSync(ready) ? JSON.parse(readFileSync(ready, "utf8")) as { id: string; pid: number } : undefined,
    };
  }, close);
}
