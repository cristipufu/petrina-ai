export { ADDRESS, createProductRepository, makeProduct, repositorySeed } from "@petrina/test-support/repositories";
import { removeDir } from "@petrina/test-support/fixtures";
export { tempDir, removeDir, waitFor, waitForFile, firstLine, testBrowserRoot } from "@petrina/test-support/fixtures";
// Lightweight private repositories, processes and fake-agent records. No Engine dependency.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { State } from "@petrina/core";
import type { Scenario } from "./fake-agent.js";
import { updateGitHub, type FakeGitHub } from "./fake-gh.js";
import type { MachineRecords } from "../src/check-interruption.js";
import { runChecks as runProductChecks, type CheckCommandExecutor, type CheckCommandOutcome, type CheckCommandRequest } from "../src/checks.js";
export type { CheckCommandExecutor, CheckCommandOutcome, CheckCommandRequest };
import { PromptReader, type PromptRecord } from "./prompt-records.js";
import { commitAt } from "@petrina/test-support/commands";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
export { testGitEnv } from "@petrina/test-support/test-git-env";
export { SLOW, currentSlow } from "@petrina/test-support/slow";
export { CommandFailure, commitAt, git, gitWith, runCommand, runGit } from "@petrina/test-support/commands";

/** The real CLI parser with the canonical fixture launch policy; no native account readers. */
export const CLI = join(import.meta.dir, "cli.ts");
export const HARNESS = join(import.meta.dir, "harness.ts");



export { newProgramsStart } from "@petrina/test-support/new-program";

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


export { headNow } from "@petrina/test-support/repository-head";

function readGitRefFile(gitDir: string, candidate: string): string | undefined {
  const file = join(gitDir, ...candidate.split("/"));
  try {
    if (existsSync(file) && statSync(file).isFile()) {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    }
  } catch { /* Fall through to packed-refs / git. */ }
  const packed = join(gitDir, "packed-refs");
  try {
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const space = line.indexOf(" ");
        if (space > 0 && line.slice(space + 1).trim() === candidate) return line.slice(0, space).trim();
      }
    }
  } catch { /* Fall back to git. */ }
  return undefined;
}

/** A ref's commit on the stand-in GitHub, or undefined when Git confirms the ref is absent. */
export function remoteRef(remote: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith("-") || /[\^~:@*{]/.test(ref) || !existsSync(join(remote, "HEAD")) || !existsSync(join(remote, "objects"))) {
    return commitAt(remote, ref);
  }
  const candidates = ref === "HEAD"
    ? ["HEAD"]
    : ref.startsWith("refs/")
      ? [ref]
      : [ref, `refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`];
  let resolved: string | undefined;
  for (const candidate of candidates) {
    let value = readGitRefFile(remote, candidate);
    for (let depth = 0; value?.startsWith("ref: ") && depth < 5; depth += 1) {
      value = readGitRefFile(remote, value.slice("ref: ".length).trim());
    }
    if (value && /^[0-9a-f]{40,64}$/.test(value)) {
      resolved = value;
      break;
    }
  }
  if (!resolved) {
    if (/^[0-9a-f]{4,64}$/.test(ref)) {
      if (/^[0-9a-f]{40,64}$/.test(ref)) resolved = ref;
      else return commitAt(remote, ref);
    } else {
      return Promise.resolve(undefined);
    }
  }
  let oid = resolved;
  for (let depth = 0; depth < 5; depth += 1) {
    const objPath = join(remote, "objects", oid.slice(0, 2), oid.slice(2));
    if (!existsSync(objPath)) return commitAt(remote, ref);
    try {
      const raw = inflateSync(readFileSync(objPath)).toString("latin1");
      if (raw.startsWith("commit ")) return Promise.resolve(oid);
      if (raw.startsWith("tag ")) {
        const next = /\0object ([0-9a-f]{40,64})\n/.exec(raw)?.[1];
        if (next) { oid = next; continue; }
      }
    } catch { /* Fall back to git. */ }
    return commitAt(remote, ref);
  }
  return commitAt(remote, ref);
}

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
