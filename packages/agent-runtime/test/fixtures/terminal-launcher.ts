import { quoteGitShellWord as quote } from "@petrina/test-support/git-program";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { runCommand, startCommand, type CommandResult, type Started } from "@petrina/test-support/commands";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { launchPlan, writeLauncher, type Platform } from "../../src/terminal.js";
import { tempDir } from "@petrina/test-support/fixtures";
import { SESSION } from "./terminal-input.js";

export interface TerminalCopy {
  readonly result: Promise<CommandResult>;
  readonly exited: Promise<number>;
  readonly stdout: Promise<string>;
  /** Signals the still-owned launcher, never a number read from its saved record. */
  signal(signal: NodeJS.Signals): void;
}

/** Actual POSIX launcher races, with private leased stand-ins and bounded, fully drained commands. */
export async function terminalLauncher(roots: string[]) {
  const root = tempDir("petrina-launcher-");
  roots.push(root);
  const lease = await createProcessLease();
  const copies: { controller: AbortController; result: Promise<CommandResult> }[] = [];
  const releases = new Set<string>(), removals = new Set<string>();
  const dir = join(root, "takeover", "task-7"), worktree = join(root, "work");
  const hold = join(root, "hold"), starts = join(root, "starts");
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    let ownershipUnconfirmed = false;
    for (const path of releases) try { writeFileSync(path, ""); } catch (error) { errors.push(error); }
    for (const path of [...removals, hold]) try { rmSync(path, { force: true }); } catch (error) { errors.push(error); }
    try { await lease.close(); } catch (error) { errors.push(error); ownershipUnconfirmed = true; }
    const ended = await Promise.allSettled(copies.map(copy => settleCommandAfterStop({ result: copy.result, abort: () => copy.controller.abort() })));
    for (const result of ended) if (result.status === "rejected") { errors.push(result.reason); ownershipUnconfirmed = true; }
    if (ownershipUnconfirmed) {
      const at = roots.indexOf(root); if (at >= 0) roots.splice(at, 1);
    }
    if (errors.length) throw new AggregateError(errors, "The terminal fixture could not confirm all of its cleanup");
  })();
  try {
    mkdirSync(worktree, { recursive: true });
    const program = (file: string, body: string) => {
      const source = `${file}.ts`;
      writeFileSync(source, lease.program(body));
      writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(source)} "$@"\n`, { mode: 0o700 });
      chmodSync(file, 0o700);
    };
    const tool = join(root, "tool");
    program(tool, `const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(starts)}, String(process.pid) + "\\n");
      while (fs.existsSync(${JSON.stringify(hold)})) {
        if (fs.existsSync(${JSON.stringify(join(root, "stop."))} + process.pid)) process.kill(process.pid, "SIGTERM");
        await Bun.sleep(50);
      }`);
    const platform: Platform = process.platform === "darwin" ? "darwin" : "linux";
    const plan = launchPlan({ platform, dir, worktree, tool: { id: "codex", name: "Codex", path: tool }, sessionId: SESSION, model: "gpt-6.1-sol", effort: "high" });
    await writeLauncher(plan, dir, true);
    const startCount = () => existsSync(starts) ? readFileSync(starts, "utf8").split("\n").filter(Boolean).length : 0;
    const toolPids = () => readFileSync(starts, "utf8").split("\n").filter(Boolean).map(Number);
    const run = (env: Record<string, string> = {}): TerminalCopy => {
      const controller = new AbortController();
      let child: Started | undefined;
      const result = runCommand(["/bin/sh", "-c", `exec ${plan.copy}`], {
        cwd: root, env: { ...process.env, ...env }, signal: controller.signal,
        // The real launcher remains the owned root after exec; the command runner drains both pipes.
        start: (argv, settings) => child = startCommand(argv, settings),
      });
      // Keep the original result for teardown, while observing failures that arrive before then.
      void result.catch(() => undefined);
      copies.push({ controller, result });
      const exited = result.then(result => result.code), stdout = result.then(result => result.stdout);
      void exited.catch(() => undefined); void stdout.catch(() => undefined);
      return { result, exited, stdout, signal(signal) {
        if (!child || child.exitCode != null || child.signalCode != null) throw new Error("The launcher is no longer owned and running");
        child.kill(signal);
      } };
    };
    return { root, dir, hold, plan, startCount, toolPids, run, program, close,
      releaseOnClose: (path: string) => { releases.add(path); },
      removeOnClose: (path: string) => { removals.add(path); },
      stopTool: (pid: number) => { writeFileSync(join(root, `stop.${pid}`), ""); },
    };
  } catch (error) { await close(); throw error; }
}
export type TerminalLauncher = Awaited<ReturnType<typeof terminalLauncher>>;
