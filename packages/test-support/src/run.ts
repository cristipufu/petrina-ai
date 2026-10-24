// Bun's isolated test workers bypass process exit hooks. Own their temporary files outside the
// workers, so even a failing run removes fixtures, private Git helpers, the run's Git configuration
// and fixtures' private browser folders after every worker stops.
import { createTestRun } from "./environment.js";
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
  return [process.execPath, "test", "--parallel", `--timeout=${FALLBACK_TIMEOUT}`, ...args];
}

if (import.meta.main) {
  const owned = createTestRun();
  try {
    const child = Bun.spawn(testCommand(process.argv.slice(2)), {
      env: owned.env,
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    let interrupted: number | undefined;
    const onInt = () => { interrupted = 130; child.kill("SIGINT"); };
    const onTerm = () => { interrupted = 143; child.kill("SIGTERM"); };
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    try {
      const code = await child.exited;
      process.exitCode = interrupted ?? code;
    }
    finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      if (interrupted) process.exitCode = interrupted;
    }
  } finally {
    owned.close();
  }
}
