import { runCommand, CommandFailure, type CommandResult } from "@petrina/test-support/commands";
import { FALLBACK_TIMEOUT } from "@petrina/test-support/run";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { waitFor } from "@petrina/test-support/fixtures";
import { engineEnv } from "../support.js";

/** An actual CLI/stdio/startup child. Canonical command ownership drains both pipes and bounds cleanup. */
export function coordinatorProcess(home: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}, options: { input?: "pipe" | "ignore" } = {}) {
  const controller = new AbortController(), lines: string[] = [];
  let child!: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>, partial = "";
  const completion = runCommand([process.execPath, ...argv], {
    env: { ...engineEnv(home), ...env }, signal: controller.signal, timeoutMs: FALLBACK_TIMEOUT,
    start: (args, settings) => {
      // A real interactive input is the boundary under test; command ownership still retains all output and exit handling.
      child = Bun.spawn(args, { ...settings, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
      if (options.input === "ignore") child.stdin.end();
      return child;
    },
    onOutput(text, stream) {
      if (stream !== "stdout") return;
      partial += text;
      for (;;) {
        const at = partial.indexOf("\n");
        if (at < 0) break;
        lines.push(partial.slice(0, at)); partial = partial.slice(at + 1);
      }
    },
  });
  void completion.catch(() => undefined);
  const exited = completion.then(result => result.code), stdout = completion.then(result => result.stdout), stderr = completion.then(result => result.stderr);
  void exited.catch(() => undefined); void stdout.catch(() => undefined); void stderr.catch(() => undefined);
  let closing: Promise<void> | undefined, finished: { result: CommandResult } | undefined;
  void completion.then(result => { finished = { result }; }, () => undefined);
  return {
    get pid() { return child.pid; },
    get exitCode() { return child.exitCode; },
    completion, exited, stdout, stderr,
    async wait(ms = 10_000) { return (await waitFor(() => finished, "the owned coordinator process to report exit and drain its output", ms, { during: completion })).result.code; },
    write(text: string) { child.stdin.write(text); },
    endInput() { child.stdin.end(); },
    line() { return waitFor(() => lines.length ? { text: lines.shift()! } : undefined, "the owned coordinator peer's next output line", undefined, { during: completion }).then(line => line.text); },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (child.exitCode == null && child.signalCode == null) child.kill(signal);
    },
    settle() { return settleCommandAfterStop({ result: completion, abort: () => controller.abort() }); },
    close() { return closing ??= (async () => {
      controller.abort();
      try { await completion; }
      catch (error) { if (!(error instanceof CommandFailure) || error.cleanup !== "confirmed") throw error; }
    })(); },
  };
}
export type CoordinatorProcess = ReturnType<typeof coordinatorProcess>;

/** A completed command's exact stdout/stderr/code, using the same private environment as app-mode fixtures. */
export function coordinatorCommand(home: string, argv: readonly string[]): Promise<CommandResult> {
  return runCommand([process.execPath, ...argv], { env: engineEnv(home) });
}
