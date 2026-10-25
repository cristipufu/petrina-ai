export { defunctProcess } from "@petrina/test-support/defunct-process";
export { ADDRESS, makeProduct, repositorySeed } from "@petrina/test-support/repositories";
import { tempDir, removeDir } from "@petrina/test-support/fixtures";
export { tempDir, removeDir, waitFor, waitForFile, firstLine, testBrowserRoot } from "@petrina/test-support/fixtures";
// Lightweight private repositories, processes and fake-agent records. No Engine dependency.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { State } from "@petrina/core";
import type { Scenario } from "./fake-agent.js";
import { updateGitHub, type FakeGitHub } from "./fake-gh.js";
import type { MachineRecords } from "../src/check-interruption.js";
import { runChecks as runProductChecks } from "../src/checks.js";
import { PromptReader, type PromptRecord } from "./prompt-records.js";
import { commitAt } from "@petrina/test-support/commands";
import { currentSlow } from "@petrina/test-support/slow";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
export { testGitEnv } from "@petrina/test-support/test-git-env";
export { SLOW, currentSlow } from "@petrina/test-support/slow";
export { CommandFailure, commitAt, git, gitWith, runCommand, runGit } from "@petrina/test-support/commands";

/** The real CLI parser with the canonical fixture launch policy; no native account readers. */
export const CLI = join(import.meta.dir, "cli.ts");
export const HARNESS = join(import.meta.dir, "harness.ts");



/**
 * Stops at once, saying why, when this machine holds back programs written a moment ago. Take-over
 * tests write small stand-ins for the launcher and the agent's app and run them. macOS checks each
 * new program before its first run, and when that check hangs, every one of those tests would
 * otherwise wait out its timeout.
 */
export function newProgramsStart(): Promise<void> {
  return (checked ??= startsNewProgram(10_000));
}

let checked: Promise<void> | undefined;

async function startsNewProgram(ms: number): Promise<void> {
  if (process.platform === "win32") return;
  const dir = tempDir("petrina-new-program-");
  const file = join(dir, "new-program");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const proc = Bun.spawn([file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const startedAt = Date.now();
  let started = false;
  while (!started && Date.now() - startedAt <= ms * currentSlow()) {
    started = await Promise.race([proc.exited.then(() => true), Bun.sleep(50).then(() => false)]);
  }
  if (!started) proc.kill("SIGKILL");
  removeDir(dir);
  if (!started) {
    throw new Error(
      `This machine did not start a program written a moment ago within ${ms / 1000} seconds, so these tests can't run here. ` +
        "On macOS that is its check of new programs not finishing: allow the app the tests run from (your terminal) in " +
        "System Settings > Privacy & Security > Developer Tools, or restart the Mac, and run them again.",
    );
  }
}

/** Leave context before a test's own timeout, without changing what it waits for or its deadline. */
export async function traceTaskWait<T>(label: string | undefined, state: () => State | Promise<State>, taskId: string, wait: () => Promise<T>): Promise<T> {
  if (!label) return wait();
  const started = Date.now();
  let finished = false;
  const report = async () => {
    try {
      const current = await state();
      if (finished) return;
      const task = current.tasks.find((entry) => entry.id === taskId);
      console.warn(`Still waiting: ${label}`, JSON.stringify({
        elapsedMs: Date.now() - started, taskId, state: task?.state, status: task?.statusLine, error: task?.error,
        stage: task?.plan?.stages[task.stageIndex]?.title, rounds: task?.rounds,
        agents: [task?.agent, ...(task?.helpers ?? [])].filter(Boolean),
        inbox: current.inbox.filter((item) => item.taskId === taskId).map((item) => ({ kind: item.kind, title: item.title })),
        tools: current.setup?.checks,
      }));
    } catch { /* Diagnostics must not replace the test's result. */ }
  };
  // This only reports progress; it is not a hang deadline and never ends or retries the wait.
  const timer = setInterval(() => void report().catch(() => undefined), 15_000);
  timer.unref();
  try { return await wait(); }
  finally { finished = true; clearInterval(timer); }
}


export interface Open {
  session: string;
  how: "new" | "resume" | "load";
  tool: string;
  background: boolean;
  logins: boolean;
  quiet: boolean;
  sandbox?: unknown;
  autoMode?: true;
  refused?: true;
}


/** A fake dir for one test: scenario, prompts, markers and the fake GitHub. */
export class Fakes {
  private readonly inputs: PromptReader;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.inputs = new PromptReader(dir);
  }

  scenario(value: Scenario): void {
    writeFixtureJson(join(this.dir, "scenario.json"), value);
  }

  github(change: (state: FakeGitHub) => void): void {
    const path = join(this.dir, "github.json");
    updateGitHub(path, change);
  }

  marked(name: string): boolean {
    return existsSync(join(this.dir, name));
  }

  /** Every complete prompt the fake agents received, in publication order. */
  prompts(role?: string): string[] {
    return this.received(role).map((entry) => entry.text);
  }

  /** Every complete prompt in publication order, with the conversation it went to. */
  received(role?: string): PromptRecord[] {
    return this.inputs.read().filter((entry) => !role || entry.role === role);
  }

  /**
   * How each conversation was opened, as which tool: whether its agent ran in the agents' environment (in the
   * background, with the coordinator's logins and nothing that asks), Claude Code's sandbox settings if it was
   * sent them, and whether it refused them.
   */
  opens(): Open[] {
    return this.lines("opens.jsonl");
  }

  /** Every setting Petrina gave a conversation, in order. */
  settings(session: string): string[] {
    return this.lines<{ session: string; configId: string; value: string }>("config.jsonl")
      .filter((entry) => entry.session === session)
      .map((entry) => `${entry.configId}=${entry.value}`);
  }

  /** The tool loses every conversation it had (cleared history, a tool update). */
  forgetConversations(): void {
    removeDir(join(this.dir, "conversations"));
  }

  private lines<T>(name: string): T[] {
    const path = join(this.dir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  /** The opening prompt of each agent of a role (the ones that say who they are). */
  openings(role: string): string[] {
    return this.prompts(role).filter((text) => /You are the [A-Za-z ]+ in Petrina/.test(text));
  }
}


export const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
export const FAKE_GH = join(import.meta.dir, "fake-gh.ts");
export const REPO = "acme/demo";


/**
 * The commit a working copy's HEAD names at this moment, read from Git's own files without starting a program:
 * for callbacks the engine calls synchronously, such as its announcements, where a Git command cannot be awaited.
 * Reads linked worktrees, detached heads and packed refs; anything else fails rather than guess.
 */
export function headNow(worktree: string): string {
  let gitDir = join(worktree, ".git");
  if (statSync(gitDir).isFile()) gitDir = resolve(worktree, /^gitdir: (.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim() ?? "");
  const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
  // A loose ref wins over packed-refs; one packed away between the two reads is found there.
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
  const sha = !ref ? head : read(join(common, ref))?.trim() ?? read(join(common, "packed-refs"))?.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error(`Could not read the HEAD of ${worktree} from Git's files (${head})`);
  return sha;
}

/** A ref's commit on the stand-in GitHub, or undefined when Git confirms the ref is absent. */
export const remoteRef = (remote: string, ref: string): Promise<string | undefined> => commitAt(remote, ref);

export { finishedHelper } from "@petrina/test-support/process-helper";

/** Synthetic failures' sleep evidence: no records, and this Mac's power log is never read. */
export const noMachineRecords: MachineRecords = async () => "";

/**
 * Production's check runs, except that sleep evidence comes from the records a test passes, else none.
 * A test that needs this Mac's real power log passes `livePowerRecords` explicitly.
 */
export function runChecks(...[cwd, checks, env, timeoutMs, signal, logDirectory, processList, onProgress, machineRecords = noMachineRecords, ...callbacks]: Parameters<typeof runProductChecks>): ReturnType<typeof runProductChecks> {
  return runProductChecks(cwd, checks, env, timeoutMs, signal, logDirectory, processList, onProgress, machineRecords, ...callbacks);
}

export { powerLogSleep, heldMachineRecords } from "../../platform/test/fixtures/machine-records.js";
