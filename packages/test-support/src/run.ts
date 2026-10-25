// Bun's isolated test workers bypass process exit hooks. Own their temporary files outside the
// workers, so even a failing run removes fixtures, private Git helpers, the run's Git configuration
// and fixtures' private browser folders after every worker stops.
import { createTestRun } from "./environment.js";
import { runProcess, SUITE_RUN_TIMEOUT_MS } from "./run-process.js";
import { testSelection } from "./test-arguments.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
export { TEST_GIT_IDENTITY } from "./environment.js";
/** Native probes invoke this same runner from arbitrary working folders. */
export const TEST_RUNNER = import.meta.path;

/**
 * An engine test's time limit when neither the command nor the test sets one. The tests drive real
 * agent processes and Git, and their waits stretch up to eight times as concurrent workers make the
 * machine busier (fixtures' SLOW), while Bun fixes a test's limit when it starts: so the fallback is
 * the full stretched allowance. Bun's own default is five seconds and it ignores a bunfig timeout.
 */
export const FALLBACK_TIMEOUT = 90_000 * 8;

/** The fallback goes before the caller's options: Bun takes the last --timeout, and a test's own limit beats both. */
export function testCommand(args: readonly string[]): string[] {
  return [process.execPath, "--no-env-file", "test", "--parallel", `--timeout=${FALLBACK_TIMEOUT}`, ...args];
}

if (import.meta.main) {
  const owned = createTestRun();
  const controller = new AbortController();
  const onInt = () => controller.abort("SIGINT"), onTerm = () => controller.abort("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    const args = process.argv.slice(2), selection = testSelection(args), cwd = resolve(selection.cwd ?? process.cwd());
    const inspected = await Promise.allSettled(selection.paths.map(async path => {
      const entry = await stat(resolve(cwd, path));
      if (!entry.isFile() && !entry.isDirectory()) throw new Error("not a file or directory");
    }));
    const errors = inspected.flatMap((result, index) => result.status === "rejected"
      ? [`${selection.paths[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (errors.length) throw new Error(`No tests ran. Explicit test paths must exist in ${cwd}:\n${errors.join("\n")}`);
    const outcome = await runProcess(testCommand(args), {
      env: owned.env, timeoutMs: SUITE_RUN_TIMEOUT_MS, signal: controller.signal, output: "inherit",
    });
    process.exitCode = outcome.kind === "interrupted" ? outcome.signal === "SIGINT" ? 130 : 143 : outcome.result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = controller.signal.aborted ? controller.signal.reason === "SIGINT" ? 130 : 143 : 1;
  } finally {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    owned.close();
  }
}
