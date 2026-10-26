import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLeasedProgramRecords, type LeasedProgramRecords } from "@petrina/test-support/leased-program-records";
import { runCommand, type CommandResult } from "@petrina/test-support/commands";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { gitCommand, writeGitProgram } from "@petrina/test-support/git-program";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { childState } from "@petrina/platform/process-tree";
import { launchPlan, openTerminal, sessionState, writeLauncher } from "../../src/terminal.js";
import { SESSION } from "./terminal-input.js";

export interface EnvironmentObservation { problem?: string; env: string[]; loginRetained: boolean; launcher: string; code: number }
const paths = (root: string) => ({ root, actors: join(root, "actors"), dir: join(root, "takeover"), work: join(root, "work"), tool: join(root, "tool"), opener: join(root, "actors", "opener.ts"), completion: join(root, "completion.json"), started: join(root, "launcher-started.json"), observation: join(root, "environment.json") });

/** An actual detached terminal boundary, called only by a private child with its synthetic inherited environment. */
async function readNativeEnvironment(root: string): Promise<EnvironmentObservation> {
  const p = paths(root);
  const plan = launchPlan({ platform: process.platform === "darwin" ? "darwin" : "linux", dir: p.dir, worktree: p.work,
    tool: { id: "codex", name: "Codex", path: p.tool }, sessionId: SESSION, model: "gpt-6.1-sol", effort: "xhigh" });
  await writeLauncher(plan, p.dir, true);
  const problem = await openTerminal({ id: "test", name: "Test terminal", open: launcher => [process.execPath, "--no-env-file", p.opener, launcher] }, plan.file);
  if (problem) throw new Error(problem);
  const completion = await waitFor(() => existsSync(p.completion) && JSON.parse(readFileSync(p.completion, "utf8")), "the real terminal launcher to exit with both pipes drained");
  if (completion.error) throw new Error(completion.error);
  await waitFor(async () => (await sessionState(p.dir)) === "ended", "the actual terminal session to end");
  return { problem, ...JSON.parse(readFileSync(p.observation, "utf8")), launcher: plan.script, code: completion.code };
}

/** Parent-owned leases survive assertion/startup failure; no process-global environment mutation. */
export async function takeoverEnvironmentFixture() {
  const root = tempDir("petrina-terminal-env-"), p = paths(root);
  registerFixtureRoot(root);
  const commands: { result: Promise<CommandResult>; controller: AbortController }[] = [];
  let programs: LeasedProgramRecords | undefined, closing: Promise<void> | undefined;
  const actors = () => programs?.records() ?? [];
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    try { await programs?.close(); } catch (error) { errors.push(error); }
    const settled = await Promise.allSettled(commands.map(command => settleCommandAfterStop({ result: command.result, abort: () => command.controller.abort() })));
    for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    try {
      await waitFor(async () => {
        const records = actors(), states = await Promise.all(records.map(actor => childState(actor.pid)));
        if (states.some(state => state !== "ended")) return false;
        const openers = records.filter(actor => actor.kind === "opener");
        for (const actor of openers) {
          const result = existsSync(p.completion) ? JSON.parse(readFileSync(p.completion, "utf8")) : undefined;
          if (result?.error) throw new Error(result.error);
          if (result?.id === actor.id && result.pid === actor.pid && Number.isSafeInteger(result.code) && result.code >= 0) continue;
          if (!existsSync(p.started)) return false;
          const started = JSON.parse(readFileSync(p.started, "utf8"));
          if (started.id !== actor.id || started.pid !== actor.pid || !Number.isSafeInteger(started.childPid) || started.childPid <= 0) return false;
          if ((await childState(started.childPid)) !== "ended") return false;
        }
        return true;
      }, "the parent's independently leased terminal actors and launcher to end", 5_000);
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `Terminal environment cleanup is unconfirmed; retained ${root}`);
    removeDir(root);
  })();
  return setupWithCleanup(async () => {
    programs = await createLeasedProgramRecords(p.actors);
    mkdirSync(p.work);
    const jsonModule = import.meta.resolve("@petrina/test-support/fixture-json"), commandModule = import.meta.resolve("@petrina/test-support/commands");
    const tool = programs.write("tool.ts", "tool", () => `
const { writeFixtureJson } = await import(${JSON.stringify(jsonModule)});
writeFixtureJson(${JSON.stringify(p.observation)}, { env: Object.keys(process.env), loginRetained: process.env.GH_TOKEN_FOR_TEST === "petrina-test-secret-value-1234" });`);
    writeGitProgram(p.tool, `exec ${gitCommand([process.execPath, "--no-env-file", tool])} "$@"`);
    programs.write("opener.ts", "opener", identity => `
const { runCommand, startCommand } = await import(${JSON.stringify(commandModule)});
const { writeFixtureJson } = await import(${JSON.stringify(jsonModule)});
const controller = new AbortController();
let launcher;
const running = runCommand(["/bin/sh", process.argv[2]], { signal: controller.signal,
  start(argv, options) { launcher = startCommand(argv, options); return launcher; },
});
void running.catch(() => undefined);
try {
  if (!Number.isSafeInteger(launcher?.pid) || launcher.pid <= 0) throw new Error("The native launcher did not report its owned identity");
  writeFixtureJson(${JSON.stringify(p.started)}, { ...${identity}, childPid: launcher.pid });
  const result = await running;
  // A separate command-result record is not inferred from the exit-hook receipt.
  writeFixtureJson(${JSON.stringify(p.completion)}, { ...${identity}, code: result.code });
  process.exit(result.code);
} catch (error) {
  controller.abort();
  try { await running; } catch { /* Preserve the original failure below; it never authorizes deletion. */ }
  writeFixtureJson(${JSON.stringify(p.completion)}, { error: String(error) });
  throw error;
}`);
    return { root, close,
      async run(env: NodeJS.ProcessEnv) {
        const controller = new AbortController();
        const result = runCommand([process.execPath, "--no-env-file", import.meta.path, root], { cwd: root, env, signal: controller.signal });
        void result.catch(() => undefined); commands.push({ result, controller });
        const completed = await result;
        if (completed.code !== 0) throw new Error(`The private terminal environment child failed: ${completed.stderr}`);
        return JSON.parse(completed.stdout) as EnvironmentObservation;
      },
    };
  }, close);
}

if (import.meta.main) {
  const observation = await readNativeEnvironment(process.argv[2]!);
  console.log(JSON.stringify(observation));
}
