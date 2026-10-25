import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executionTestResults, requireFiles } from "@petrina/test-support/test-results";
import type { ExecutionEvidence, SuiteExecution, WorkspaceEvidence } from "@petrina/test-support/suite-coordinator";
import { runProcess, SUITE_RUN_TIMEOUT_MS } from "@petrina/test-support/run-process";
import { testCommand } from "@petrina/test-support/run";
import { CommandFailure } from "@petrina/test-support/commands";
import { NATIVE_SCOPE } from "./required-plan.js";
import { fileURLToPath } from "node:url";

export interface TestExecution {
  root: string;
  folder: string;
  expectedFiles: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Exact native file selection; Vitest feedback runs complete selected workspaces. */
  files?: readonly string[];
  /** Only the complete run owns required-suite duration hints. */
  timings?: string;
  /** Opt-in observers; diagnostic results never establish delivery evidence. */
  resources?: string;
}

/** Native execution and complete report verification, shared without sharing delivery policy. */
export async function executeTests(execution: SuiteExecution, options: TestExecution): Promise<ExecutionEvidence> {
  const { root, folder, expectedFiles, env, signal } = options;
  const native = execution.id === NATIVE_SCOPE.id;
  if (options.files && (!native || !options.files.length || new Set(options.files).size !== options.files.length
    || options.files.some(file => !expectedFiles.includes(file) || !execution.workspaces.some(workspace => file.startsWith(`${workspace}/`))))) {
    throw new Error("Exact native selection requires unique files from this execution's expected manifest; Vitest runs complete workspaces");
  }
  const cwd = join(root, native ? NATIVE_SCOPE.cwd : execution.workspaces[0]!);
  const output = join(folder, `${native ? "native" : execution.id.split("/").at(-1)}.${native ? "xml" : "json"}`);
  const selector = (path: string) => {
    const local = relative(cwd, join(root, path));
    return local.startsWith(".") ? local : `./${local}`;
  };
  const selectors = options.files ? options.files.map(selector)
    : native ? execution.workspaces.map(workspace => selector(`${workspace}/test`)) : [];
  const command = native ? testCommand([...selectors, "--reporter=junit", `--reporter-outfile=${output}`,
    ...(options.resources ? ["--preload", fileURLToPath(import.meta.resolve("@petrina/test-support/resources/preload"))] : []),
    ...(options.timings ? [`--timings=${options.timings}`, "--update-timings"] : [])])
    : [process.execPath, "--no-env-file", "run", "test", ...selectors, "--reporter=json", `--outputFile=${output}`,
      ...(options.resources ? [`--reporter=${fileURLToPath(import.meta.resolve("@petrina/test-support/resources/vitest-reporter"))}`, "--logHeapUsage"] : [])];
  const start = performance.now();
  let code: number | null = null, executionError: string | undefined;
  try {
    const outcome = await runProcess(command, { cwd, env: options.resources ? { ...env, PETRINA_TEST_RESOURCE_DIR: options.resources } : env, timeoutMs: SUITE_RUN_TIMEOUT_MS, signal, output: "inherit" });
    code = outcome.result.code;
  } catch (error) {
    if (!(error instanceof CommandFailure)) throw error;
    code = error.code ?? null;
    executionError = error.message;
  }
  const ms = Math.round(performance.now() - start);
  let workspaces: WorkspaceEvidence[];
  try {
    const parsed = executionTestResults(readFileSync(output, "utf8"), { root, cwd, runner: native ? "bun" : "vitest", workspaces: execution.workspaces });
    workspaces = parsed.workspaces.map(work => {
      const { workspace, files, failures, ...counts } = work;
      try {
        requireFiles(work, expectedFiles.filter(file => file.startsWith(`${workspace}/`)));
        return { workspace, failures, counts, reportComplete: true };
      } catch (error) { return { workspace, failures, counts, error: `Incomplete test evidence: ${error instanceof Error ? error.message : String(error)}` }; }
    });
    if (code !== 0 && !parsed.total.failures.length) executionError ??= "Run failed without an attributable test file; selection accuracy is unknown";
  } catch (error) {
    const message = `Incomplete test evidence: ${error instanceof Error ? error.message : String(error)}`;
    workspaces = execution.workspaces.map(workspace => ({ workspace, error: message }));
  }
  if (executionError) console.error(`${execution.id}: ${executionError}`);
  for (const work of workspaces) {
    if (work.error) console.error(`${work.workspace}: ${work.error}`);
    else if (code === 0 && work.failures?.length) console.error(`${work.workspace}: structured results report failed files despite a zero exit code: ${work.failures.join(", ")}`);
  }
  return { code, ms, workspaces, ...(executionError ? { error: executionError } : {}) };
}
