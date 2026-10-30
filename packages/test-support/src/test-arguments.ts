/** Bun options with a separate value. An equals-form option is already self-contained. */
const WITH_VALUE = new Set(["-t", "--test-name-pattern", "--timeout", "--rerun-each", "--retry", "--seed", "--coverage-reporter", "--coverage-dir",
  "--reporter", "--reporter-outfile", "--max-concurrency", "--path-ignore-patterns", "--parallel-delay", "--shard", "--timings",
  "--preload", "-r", "--require", "--import", "--env-file", "--config", "-c", "--cwd", "--tsconfig-override", "--define", "-d", "--loader", "-l", "--conditions",
  "--cpu-prof-name", "--cpu-prof-dir", "--cpu-prof-interval", "--heap-prof-name", "--heap-prof-dir", "--heap-prof-interval", "--fetch-preconnect",
  "--redirect-warnings", "--main-fields", "--extension-order", "--drop", "--feature", "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime",
  "--elide-lines", "-F", "--filter", "--shell", "--watch-kill-signal", "--install", "-e", "--eval", "-p", "--print", "--port",
  "--max-http-header-size", "--dns-result-order", "--disable-warning", "--title", "--unhandled-rejections", "--console-depth", "--user-agent", "--cron-title", "--cron-period"]);
const OPTIONAL_NUMBER = new Set(["--parallel", "--bail"]);

/**
 * Explicit file/directory selectors must exist; otherwise Bun can silently ignore a typo
 * when another selector matches. Bare name filters remain Bun's responsibility. Option
 * values are not selectors, even when they name a not-yet-created report or contain slashes.
 */
export function testSelection(args: readonly string[]): { paths: string[]; cwd?: string } {
  const paths: string[] = [];
  let positional = false;
  let cwd: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!positional && argument === "--") {
      positional = true;
      continue;
    }
    if (!positional && argument.startsWith("-")) {
      if (argument.startsWith("--cwd=")) cwd = argument.slice("--cwd=".length);
      else if (WITH_VALUE.has(argument)) {
        if (argument === "--cwd") cwd = args[index + 1];
        index++;
      }
      else if (OPTIONAL_NUMBER.has(argument) && /^\d+$/.test(args[index + 1] ?? "")) index++;
      continue;
    }
    if (/[\\/]/.test(argument)) paths.push(argument);
  }
  return { paths: [...new Set(paths)], ...(cwd !== undefined ? { cwd } : {}) };
}
