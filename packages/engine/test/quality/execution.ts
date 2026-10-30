import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, SUITE_RUN_TIMEOUT_MS } from "@petrina/test-support/run-process";
import type { RunSettlements } from "@petrina/test-support/run-settlement";
import { testCommand } from "@petrina/test-support/run";
import type { ExecutionEvidence, SuiteExecution, WorkspaceEvidence } from "@petrina/test-support/suite-coordinator";
import { executionTestResults, requireFiles } from "@petrina/test-support/test-results";
import { NATIVE_SCOPE } from "./required-plan.js";

export interface TestExecution {
  root: string;
  folder: string;
  expectedFiles: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** One shared record prevents disposal or a later execution after uncertain command cleanup. */
  settlements: Pick<RunSettlements, "observe">;
  /** Exact file selection within this execution's workspaces; omitted by the full required run. */
  files?: readonly string[];
  /** Only the complete run owns required-suite duration hints. */
  timings?: string;
  /** Opt-in observers; diagnostic results never establish delivery evidence. */
  resources?: string;
}

const SKIPPED_SCAN_DIRS = new Set([".git", ".test-results", "coverage", "dist", "node_modules", "target"]);
const VITEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function escapeGlob(path: string): string {
  return path.replace(/[*?[\](){}!+@\\]/g, "\\$&");
}

function vitestTestFiles(cwd: string, prefix = ""): string[] {
  const discovered: string[] = [];
  for (const entry of readdirSync(prefix ? join(cwd, prefix) : cwd, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_SCAN_DIRS.has(entry.name)) discovered.push(...vitestTestFiles(cwd, rel));
    } else if ((entry.isFile() || entry.isSymbolicLink()) && VITEST_FILE_PATTERN.test(entry.name)) {
      discovered.push(rel);
    }
  }
  return discovered;
}

function vitestCollisionExcludes(cwd: string, root: string, files: readonly string[]): string[] {
  const selected = files.map((file) => relative(cwd, join(root, file)).replaceAll("\\", "/"));
  const selectedSet = new Set(selected);
  const selectedLower = selected.map((file) => file.toLowerCase());
  return vitestTestFiles(cwd)
    .filter(
      (candidate) =>
        !selectedSet.has(candidate)
        && selectedLower.some((filter) => candidate.toLowerCase().includes(filter)),
    )
    .sort()
    .map((candidate) => `--exclude=${escapeGlob(candidate)}`);
}

/** Native execution and complete report verification, shared without sharing delivery policy. */
export async function executeTests(execution: SuiteExecution, options: TestExecution): Promise<ExecutionEvidence> {
  const { root, folder, expectedFiles, env, signal } = options;
  const native = execution.id === NATIVE_SCOPE.id;
  if (
    options.files
    && (
      !options.files.length
      || new Set(options.files).size !== options.files.length
      || options.files.some(
        (file) =>
          !expectedFiles.includes(file)
          || !execution.workspaces.some((workspace) => file.startsWith(`${workspace}/`)),
      )
    )
  ) {
    throw new Error(
      "Exact file selection requires unique files from this execution's expected manifest",
    );
  }

  const cwd = join(root, native ? NATIVE_SCOPE.cwd : execution.workspaces[0]!);
  const output = join(folder, `${native ? "native" : execution.id.split("/").at(-1)}.${native ? "xml" : "json"}`);
  const selector = (path: string) => {
    const local = relative(cwd, join(root, path));
    return local.startsWith(".") ? local : `./${local}`;
  };
  const selectors = options.files
    ? options.files.map(selector)
    : native
      ? execution.workspaces.map((workspace) => selector(`${workspace}/test`))
      : [];
  const excludes = !native && options.files ? vitestCollisionExcludes(cwd, root, options.files) : [];

  const command = native
    ? testCommand([
      ...selectors,
      "--reporter=junit",
      `--reporter-outfile=${output}`,
      ...(options.resources
        ? ["--preload", fileURLToPath(import.meta.resolve("@petrina/test-support/resources/preload"))]
        : []),
      ...(options.timings ? [`--timings=${options.timings}`, "--update-timings"] : []),
    ])
    : [
      process.execPath,
      "--no-env-file",
      "run",
      "test",
      ...selectors,
      ...excludes,
      "--reporter=json",
      `--outputFile=${output}`,
      ...(options.resources
        ? [
          `--reporter=${fileURLToPath(import.meta.resolve("@petrina/test-support/resources/vitest-reporter"))}`,
          "--logHeapUsage",
        ]
        : []),
    ];

  const start = performance.now();
  let code: number | null = null;
  let executionError: string | undefined;
  const observation = await options.settlements.observe({
    run: () =>
      runProcess(command, {
        cwd,
        env: options.resources ? { ...env, PETRINA_TEST_RESOURCE_DIR: options.resources } : env,
        timeoutMs: SUITE_RUN_TIMEOUT_MS,
        signal,
        output: "inherit",
      }),
  });
  if (observation.kind === "completed") {
    code = observation.result.result.code;
  } else {
    // Do not read a report that an unconfirmed process may still write, or start another workspace.
    if (!observation.safeToDispose) throw observation.error;
    const error = observation.error;
    code = error.code ?? null;
    executionError = error.message;
  }

  const ms = Math.round(performance.now() - start);
  let workspaces: WorkspaceEvidence[];
  try {
    const parsed = executionTestResults(readFileSync(output, "utf8"), {
      root,
      cwd,
      runner: native ? "bun" : "vitest",
      workspaces: execution.workspaces,
    });
    workspaces = parsed.workspaces.map((work) => {
      const { workspace, files: _files, failures, ...counts } = work;
      try {
        requireFiles(work, expectedFiles.filter((file) => file.startsWith(`${workspace}/`)));
        return { workspace, failures, counts, reportComplete: true };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { workspace, failures, counts, error: `Incomplete test evidence: ${detail}` };
      }
    });
    if (code !== 0 && !parsed.total.failures.length) {
      executionError ??= "Run failed without an attributable test file; selection accuracy is unknown";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Incomplete test evidence: ${detail}`;
    workspaces = execution.workspaces.map((workspace) => ({ workspace, error: message }));
  }

  if (executionError) console.error(`${execution.id}: ${executionError}`);
  for (const work of workspaces) {
    if (work.error) {
      console.error(`${work.workspace}: ${work.error}`);
    } else if (code === 0 && work.failures?.length) {
      console.error(
        `${work.workspace}: structured results report failed files despite a zero exit code: ${work.failures.join(", ")}`,
      );
    }
  }
  return { code, ms, workspaces, ...(executionError ? { error: executionError } : {}) };
}
