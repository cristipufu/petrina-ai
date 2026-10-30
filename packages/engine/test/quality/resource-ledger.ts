// Offline analysis of retained resource events. This command never starts a test or a product.

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ResourceSummary } from "@petrina/test-support/resources/summary";
import { MAX_NATIVE_LAUNCHES, verifyResourceReconciliation } from "./resource-limits.js";

const RESULTS_ROOT = resolve(import.meta.dir, "../../../../.test-results/resources");

const latestCaptureFolder = (): string | undefined => {
  if (!existsSync(RESULTS_ROOT)) return undefined;
  const entries = readdirSync(RESULTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(RESULTS_ROOT, entry.name, "expected-files.json")))
    .map((entry) => {
      const fullPath = join(RESULTS_ROOT, entry.name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs, name: entry.name };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return entries[0]?.fullPath;
};

const usage = () => {
  console.log(
    "bun packages/engine/test/quality/resource-ledger.ts [--check] [--max-launches N] [CAPTURE] [OUTPUT]\n"
      + `Rebuild complete per-test, file, directory and caller rankings without running tests (--check enforces the ${MAX_NATIVE_LAUNCHES} native launch ceiling; defaults CAPTURE to the newest .test-results/resources/* run).`,
  );
};

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 1 && ["--help", "-h"].includes(rawArgs[0]!)) {
  usage();
  process.exit(0);
}

let checkLaunchCeiling = false;
let maxNativeLaunches: number | undefined;
const positional: string[] = [];
for (let index = 0; index < rawArgs.length; index++) {
  const token = rawArgs[index]!;
  if (token === "--check") {
    checkLaunchCeiling = true;
  } else if (token === "--max-launches") {
    const next = rawArgs[++index];
    const parsed = next !== undefined ? Number(next) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 0) {
      usage();
      process.exit(1);
    }
    maxNativeLaunches = parsed;
    checkLaunchCeiling = true;
  } else if (token.startsWith("-")) {
    usage();
    process.exit(1);
  } else {
    positional.push(token);
  }
}

if (positional.length > 2) {
  usage();
  process.exit(1);
}

const resolvedCapture = positional[0] ? resolve(positional[0]) : latestCaptureFolder();
if (!resolvedCapture) {
  console.error("No resource capture folder supplied and none found under .test-results/resources.");
  usage();
  process.exit(1);
}

const capture = resolvedCapture;
const output = positional[1] ? resolve(positional[1]) : join(capture, "ledger");
const summary = new ResourceSummary();
const seen = new Set<string>();
const perCase = new Map<string, { programs: Record<string, number>; gitOperations: Record<string, number> }>();
const perCaller = new Map<string, { launches: number; cases: Set<string>; operations: Record<string, number> }>();

let invalidLines = 0;
let nativeLaunches = 0;
let unattributed = 0;

const increment = (counts: Record<string, number>, name: string) => {
  counts[name] = (counts[name] ?? 0) + 1;
};

const expected = JSON.parse(readFileSync(join(capture, "expected-files.json"), "utf8")) as string[];
const canonical = (file: string) =>
  expected.find((path) => file === path || file.replaceAll("\\", "/").endsWith("/" + path)) ?? file;

const rows = async (name: string, accept: (row: Record<string, unknown>) => void) => {
  const stream = createInterface({ input: createReadStream(join(capture, name)), crlfDelay: Infinity });
  for await (const line of stream) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        invalidLines++;
        continue;
      }
    } catch {
      invalidLines++;
      continue;
    }
    accept(row);
  }
};

const eventFiles = readdirSync(capture)
  .filter((name) => /^events-.*\.jsonl$/.test(name))
  .sort();

for (const file of eventFiles) {
  await rows(file, (row) => {
    summary.accept(row);
    if (row.kind !== "spawn" || typeof row.id !== "string" || seen.has(row.id)) return;
    seen.add(row.id);
    nativeLaunches++;
    const owner = row.case as { id?: string; file?: string; name?: string } | undefined;
    const owned =
      typeof owner?.id === "string"
      && !!owner.id
      && typeof owner.file === "string"
      && typeof owner.name === "string";
    const program = typeof row.program === "string" ? row.program : "unknown";
    if (owned) {
      const cost = perCase.get(owner.id!) ?? { programs: {}, gitOperations: {} };
      increment(cost.programs, program);
      if (program === "git") {
        increment(cost.gitOperations, typeof row.operation === "string" ? row.operation : "unknown");
      }
      perCase.set(owner.id!, cost);
    } else {
      unattributed++;
    }
    if (program === "git") {
      const label = typeof row.caller === "string" ? row.caller : "Caller unavailable";
      const caller = perCaller.get(label) ?? { launches: 0, cases: new Set<string>(), operations: {} };
      caller.launches++;
      if (owned) caller.cases.add(owner.id!);
      increment(caller.operations, typeof row.operation === "string" ? row.operation : "unknown");
      perCaller.set(label, caller);
    }
  });
}

await rows("vitest-cases.jsonl", (row) => {
  if (row.kind === "vitest-case") {
    summary.accept({
      ...row,
      runner: "vitest",
      kind: "case-end",
      case: { id: row.id, file: row.file, name: row.name },
    });
  } else if (row.kind === "vitest-file") {
    summary.accept({ kind: "file-end", file: row.file });
  } else if (row.kind === "truncated") {
    summary.accept(row);
  }
});

const all = summary.report(Number.MAX_SAFE_INTEGER);
const costs = new Map(
  [...all.topByLaunches, ...all.topByDuration, ...all.topByReportedHeap].map((cost) => [cost.id, cost]),
);
if (costs.size !== all.observedCases) {
  throw new Error("The complete case inventory could not be reconstructed");
}

const cases = [...costs.values()]
  .map((cost) => ({
    ...cost,
    file: canonical(cost.file),
    launchCoverage: cost.runner === "bun" ? "instrumented" : "not instrumented",
    programs: perCase.get(cost.id)?.programs ?? {},
    gitOperations: perCase.get(cost.id)?.gitOperations ?? {},
  }))
  .sort(
    (a, b) =>
      b.launches - a.launches
      || (b.wallMs ?? 0) - (a.wallMs ?? 0)
      || a.file.localeCompare(b.file)
      || a.name.localeCompare(b.name),
  );

const attributed = cases.reduce((total, cost) => total + cost.launches, 0);
if (nativeLaunches !== all.observedLaunchCalls || attributed + unattributed !== nativeLaunches) {
  throw new Error("Per-test launches do not reconcile with the captured total");
}
for (const cost of cases) {
  if (Object.values(cost.programs).reduce((total, count) => total + count, 0) !== cost.launches) {
    throw new Error(`Program counts do not reconcile for ${cost.file}: ${cost.name}`);
  }
}

interface AggregatedFile {
  file: string;
  cases: number;
  nativeCases: number;
  runners: string[];
  launches: number;
  programs: Record<string, number>;
  callbackReadings: number;
  callbackMsSum: number;
  observedExits: number;
  cpuReadings: number;
  rssReadings: number;
  observedChildCpuUs?: number;
  largestObservedChildRssBytes?: number;
}

const filesByName = new Map<string, AggregatedFile>();
for (const file of [...expected, ...all.completedFiles.map(canonical), ...cases.map((cost) => cost.file)]) {
  if (!filesByName.has(file)) {
    filesByName.set(file, {
      file,
      cases: 0,
      nativeCases: 0,
      runners: [],
      launches: 0,
      programs: {},
      callbackReadings: 0,
      callbackMsSum: 0,
      observedExits: 0,
      cpuReadings: 0,
      rssReadings: 0,
    });
  }
}

for (const cost of cases) {
  const file = filesByName.get(cost.file)!;
  file.cases++;
  if (cost.runner === "bun") file.nativeCases++;
  if (!file.runners.includes(cost.runner)) file.runners.push(cost.runner);
  file.launches += cost.launches;
  file.observedExits += cost.observedExits;
  file.cpuReadings += cost.cpuReadings;
  file.rssReadings += cost.rssReadings;
  if (cost.wallMs !== undefined) {
    file.callbackReadings++;
    file.callbackMsSum += cost.wallMs;
  }
  if (cost.observedChildCpuUs !== undefined) {
    file.observedChildCpuUs = (file.observedChildCpuUs ?? 0) + cost.observedChildCpuUs;
  }
  if (cost.largestObservedChildRssBytes !== undefined) {
    file.largestObservedChildRssBytes = Math.max(
      file.largestObservedChildRssBytes ?? 0,
      cost.largestObservedChildRssBytes,
    );
  }
  for (const [program, count] of Object.entries(cost.programs)) {
    file.programs[program] = (file.programs[program] ?? 0) + count;
  }
}

const coverageOf = (total: number, native: number) =>
  !total ? "no executed cases" : native === total ? "instrumented" : !native ? "not instrumented" : "mixed";

const files = [...filesByName.values()]
  .map((file) => ({ ...file, launchCoverage: coverageOf(file.cases, file.nativeCases) }))
  .sort((a, b) => b.launches - a.launches || a.file.localeCompare(b.file));

const caseFiles = new Map(cases.map((cost) => [cost.id, cost.file]));
const callers = [...perCaller]
  .map(([caller, cost]) => ({
    caller,
    launches: cost.launches,
    cases: [...cost.cases].sort(),
    files: [...new Set([...cost.cases].map((id) => caseFiles.get(id)!).filter(Boolean))].sort(),
    operations: cost.operations,
  }))
  .sort((a, b) => b.launches - a.launches || a.caller.localeCompare(b.caller));

interface AggregatedGroup {
  files: string[];
  cases: number;
  nativeCases: number;
  launches: number;
  programs: Record<string, number>;
  callbackMsSum: number;
  callbackReadings: number;
  cpuReadings: number;
  observedChildCpuUs?: number;
}

const groups = new Map<string, AggregatedGroup>();
for (const cost of files) {
  const folder = cost.file.slice(0, cost.file.lastIndexOf("/"));
  const group = groups.get(folder) ?? {
    files: [],
    cases: 0,
    nativeCases: 0,
    launches: 0,
    programs: {},
    callbackMsSum: 0,
    callbackReadings: 0,
    cpuReadings: 0,
  };
  if (!group.files.includes(cost.file)) group.files.push(cost.file);
  group.cases += cost.cases;
  group.nativeCases += cost.nativeCases;
  group.launches += cost.launches;
  group.callbackMsSum += cost.callbackMsSum;
  group.callbackReadings += cost.callbackReadings;
  group.cpuReadings += cost.cpuReadings;
  if (cost.observedChildCpuUs !== undefined) {
    group.observedChildCpuUs = (group.observedChildCpuUs ?? 0) + cost.observedChildCpuUs;
  }
  for (const [program, count] of Object.entries(cost.programs)) {
    group.programs[program] = (group.programs[program] ?? 0) + count;
  }
  groups.set(folder, group);
}

const directories = [...groups]
  .map(([directory, cost]) => ({
    directory,
    ...cost,
    launchCoverage: coverageOf(cost.cases, cost.nativeCases),
  }))
  .sort((a, b) => b.launches - a.launches);

const source = JSON.parse(readFileSync(join(capture, "source.json"), "utf8"));
let run: Record<string, unknown> | undefined;
try {
  run = JSON.parse(readFileSync(join(capture, "run.json"), "utf8"));
} catch {
  /* Historical captures may lack collector evidence. */
}
if (!run || typeof run !== "object" || Array.isArray(run)) run = undefined;

const sampling = run?.sampling as { errors?: unknown } | undefined;
const quality = {
  observerErrors: typeof run?.observerErrors === "number" ? run.observerErrors : undefined,
  outputTruncated: Array.isArray(run?.outputTruncated) ? run.outputTruncated : undefined,
  samplingErrors: Array.isArray(sampling?.errors) ? sampling.errors : undefined,
  collectorExitCode: typeof run?.code === "number" ? run.code : undefined,
  fullExitCode: typeof run?.fullExitCode === "number" ? run.fullExitCode : undefined,
  afterExitProcesses: Array.isArray(run?.afterExitProcesses) ? run.afterExitProcesses : undefined,
};
const unknownCaptureEvidence = Object.entries(quality)
  .filter(([, value]) => value === undefined)
  .map(([key]) => key);
const completedFiles = new Set(all.completedFiles.map(canonical));
const missingFiles = expected.filter((file) => !completedFiles.has(file));

const reconciliation = {
  nativeLaunches,
  attributed,
  unattributed,
  caseCount: cases.length,
  nativeCaseCount: cases.filter((cost) => cost.runner === "bun").length,
  files: files.length,
  nativeFiles: files.filter((file) => file.nativeCases).length,
  missingFiles,
  quality,
  unknownCaptureEvidence,
  invalidLines,
  unfinishedCases: all.unfinishedCases,
  truncated: all.truncated,
  launchesWithoutObservedExit: all.launchesWithoutObservedExit,
  failedLaunchCalls: all.failedLaunchCalls,
};

mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries({ cases, files, callers, directories, reconciliation })) {
  writeFileSync(join(output, name + ".json"), JSON.stringify(value, null, 2) + "\n");
}

const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
let cumulative = 0;
const csvHeader = [
  "rank",
  "file",
  "test",
  "launches",
  "git",
  "bun",
  "ps",
  "node",
  "callback_ms",
  "observed_child_cpu_us",
  "largest_child_rss_bytes",
  "cumulative_launch_percent",
].join(",");

const csvRows = cases
  .filter((cost) => cost.runner === "bun")
  .map((cost, index) => {
    cumulative += cost.launches;
    return [
      index + 1,
      cost.file,
      cost.name,
      cost.launches,
      cost.programs.git ?? 0,
      cost.programs.bun ?? 0,
      cost.programs.ps ?? 0,
      cost.programs.node ?? 0,
      cost.wallMs,
      cost.observedChildCpuUs,
      cost.largestObservedChildRssBytes,
      nativeLaunches ? ((100 * cumulative) / nativeLaunches).toFixed(3) : undefined,
    ]
      .map(csv)
      .join(",");
  });

writeFileSync(join(output, "cases.csv"), [csvHeader, ...csvRows].join("\n") + "\n");

const readmeText = [
  "# Complete captured test cost",
  "",
  `Source: ${JSON.stringify(source)}`,
  "",
  "Every observed native test is ranked in cases.csv. JSON tables retain all case, file, directory and Git caller rows, without a top-twenty cutoff. Directories are exclusive location groups, not claims of a shared semantic cause. Fixture/controller grouping requires source review.",
  "",
  JSON.stringify(reconciliation, null, 2),
  "",
  "CPU is observed child usage, which may include descendants. Callback times overlap; largest-child RSS is not aggregate case memory. Vitest launch counts are uninstrumented. Unattributed hooks/setup stay separate. Failed starts are separate from successful launch calls. This offline analysis runs no tests and cannot authorize delivery.",
  "",
].join("\n");

writeFileSync(join(output, "README.md"), readmeText);
const violations = verifyResourceReconciliation(reconciliation, { checkLaunchCeiling, maxNativeLaunches });
console.log(
  JSON.stringify(
    {
      output,
      ...reconciliation,
      ...(checkLaunchCeiling ? { maxNativeLaunches: maxNativeLaunches ?? MAX_NATIVE_LAUNCHES } : {}),
      violations,
    },
    null,
    2,
  ),
);

if (violations.length) {
  for (const violation of violations) console.error(`Resource verification failed: ${violation}`);
  process.exitCode = 1;
}
