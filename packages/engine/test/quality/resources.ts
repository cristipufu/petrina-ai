// Repeatable opt-in full-suite measurement. Observers never authorize delivery or seed required-run timings.

import { appendFileSync, createReadStream, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseProcessMetrics, processMetricsPlan, SampledProcessTree } from "@petrina/platform/process-metrics";
import { runCommand, CommandFailure, type Start, type Started } from "@petrina/test-support/commands";
import { createTestRun } from "@petrina/test-support/environment";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { ResourceSummary } from "@petrina/test-support/resources/summary";
import { resourceUsageRecord } from "@petrina/test-support/resources/usage";
import { SUITE_RUN_TIMEOUT_MS } from "@petrina/test-support/run-process";
import { runSettlements } from "@petrina/test-support/run-settlement";
import { ROOT } from "./repository.js";

const SAMPLING_LIMITS = [
  "One-second samples miss short-lived children.",
  "Present process entries include zombies.",
  "RSS sums shared pages.",
  "ps CPU is rolling; Windows exposes cumulative CPU instead.",
  "Processes are associated by observed parent/birth identities; same-second PID reuse between samples can be indistinguishable.",
].join(" ");

async function report(folder: string): Promise<void> {
  const result = new ResourceSummary();
  let invalidLines = 0;
  const files = readdirSync(folder).filter((name) => /^events-.*\.jsonl$/.test(name));
  for (const name of files) {
    const lines = createInterface({ input: createReadStream(join(folder, name)), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        result.accept(JSON.parse(line));
      } catch {
        invalidLines++;
      }
    }
  }

  let vitestCases = 0;
  const vitest = join(folder, "vitest-cases.jsonl");
  try {
    const lines = createInterface({ input: createReadStream(vitest), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.kind === "vitest-case") {
          vitestCases++;
          result.accept({
            ...row,
            runner: "vitest",
            kind: "case-end",
            case: { id: row.id, file: row.file, name: row.name },
          });
        } else if (row.kind === "vitest-file") {
          result.accept({ kind: "file-end", file: row.file });
        } else if (row.kind === "truncated") {
          result.accept(row);
        }
      } catch {
        invalidLines++;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const metrics = result.report();
  if (!metrics.observedCases) throw new Error("No valid resource case evidence was found in that folder.");

  const optional = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(folder, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
  };

  const expected = optional("expected-files.json") as string[] | undefined;
  const normalize = (file: string) =>
    relative(ROOT, file.startsWith("file:") ? fileURLToPath(file) : resolve(ROOT, file)).replaceAll("\\", "/");
  const complete = new Set(metrics.completedFiles.map(normalize));
  const missingFileObservations = expected?.filter((file) => !complete.has(file));
  const run = optional("run.json") as
    | { rootUsage?: { userUs?: unknown; systemUs?: unknown; totalUs?: unknown; maxRssBytes?: unknown } }
    | undefined;
  const measured = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const unavailableMetrics = [
    ...(!measured(run?.rootUsage?.totalUs) && !(measured(run?.rootUsage?.userUs) && measured(run?.rootUsage?.systemUs))
      ? ["Root child driver CPU counters were not recorded."]
      : []),
    ...(!measured(run?.rootUsage?.maxRssBytes) ? ["Root child driver memory counter was not recorded."] : []),
  ];

  const summary = {
    formatVersion: 2,
    kind: "resource-diagnostic",
    deliveryEligible: false,
    source: optional("source.json"),
    run,
    unavailableMetrics,
    missingFileObservations,
    coverage: expected
      ? "compared with recorded file manifest; uninstrumented descendants remain unmeasured"
      : "no recorded file manifest; observation coverage is unverified",
    eventFiles: files.length,
    invalidLines,
    vitestCases,
    ...metrics,
  };
  writeFixtureJson(join(folder, "summary.json"), summary, 2);
  console.log(
    `Resource report: ${folder}\n`
      + `Observed launch calls: ${summary.observedLaunchCalls}; reported child PIDs: ${summary.callsWithReportedChildPid}; `
      + `unattributed: ${summary.unattributedLaunches}. Observed cases: ${summary.observedCases} (${vitestCases} Vitest).`,
  );
  for (const cost of summary.topByDuration) {
    const launchText = cost.runner === "bun" ? `${cost.launches} observed launch calls` : "launches not observed";
    console.log(`  ${((cost.wallMs ?? 0) / 1000).toFixed(2)}s · ${launchText} · ${cost.file}: ${cost.name}`);
  }
}

const args = process.argv.slice(2);
if (args.length) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(
      "bun run test:resources              Run the unchanged full suite with resource observers\n"
        + "bun run test:resources --report DIR Summarize retained resource events without rerunning tests\n"
        + "Reports are diagnostics, never delivery evidence. Do not overlap full suites.",
    );
  } else if (args.length === 2 && args[0] === "--report") {
    await report(resolve(args[1]!));
  } else {
    console.error("Use test:resources, --help, or --report DIR. No tests ran.");
    process.exitCode = 1;
  }
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = join(ROOT, ".test-results", "resources", `${stamp}-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(folder, { recursive: true });
  console.log(`Measuring the required full suite with normal workers. Resource artifacts: ${folder}`);

  const owned = createTestRun();
  const controller = new AbortController();
  const settlements = runSettlements();
  let disposal: Promise<boolean> | undefined;
  let disposalFailure: { error: unknown } | undefined;
  const dispose = () =>
    (disposal ??= settlements.dispose(owned).catch((error) => {
      disposalFailure = { error };
      return false;
    }));

  let interrupted: number | undefined;
  const onInt = () => {
    interrupted = 130;
    controller.abort("SIGINT");
  };
  const onTerm = () => {
    interrupted = 143;
    controller.abort("SIGTERM");
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const began = performance.now();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let finished = false;
  let code: number | undefined;
  let failure: string | undefined;
  let fullFailureExecution: CommandFailure["execution"];
  let fullExitCode: number | null | undefined;
  const errors: string[] = [];
  const samplerFailures: {
    sample: number;
    phase: "running" | "after-exit";
    execution: NonNullable<CommandFailure["execution"]>;
  }[] = [];
  const logBytes = { stdout: 0, stderr: 0 };
  const outputTruncated = new Set<string>();
  const observerTails = { stdout: "", stderr: "" };
  let observerErrors = 0;

  const start: Start = (argv, options): Started => {
    const { output: _output, ...native } = options;
    const current = Bun.spawn(argv, { ...native, stdout: "pipe", stderr: "pipe", windowsHide: true });
    child = current;
    return {
      pid: current.pid,
      stdout: current.stdout as ReadableStream<Uint8Array>,
      stderr: current.stderr as ReadableStream<Uint8Array>,
      exited: current.exited,
      get exitCode() {
        return current.exitCode;
      },
      get signalCode() {
        return current.signalCode as string | null;
      },
      ...(options.detached ? { interrupt: (signal: "SIGINT" | "SIGTERM") => current.kill(signal) } : {}),
      kill: (signal) => current.kill(signal),
    };
  };

  const full = settlements
    .observe({
      run: () =>
        runCommand([process.execPath, "--no-env-file", join(ROOT, "packages/engine/test/quality/full-run.ts")], {
          cwd: ROOT,
          env: {
            ...owned.env,
            PETRINA_TEST_RESOURCE_DIR: folder,
            PETRINA_TEST_RESOURCE_PARENT: String(process.pid),
          },
          timeoutMs: SUITE_RUN_TIMEOUT_MS + 30_000,
          signal: controller.signal,
          start,
          retainOutput: false,
          onOutput: (text, stream) => {
            const marker = "[petrina-resource-observer-error]";
            const combined = observerTails[stream] + text;
            observerErrors += combined.split(marker).length - 1;
            observerTails[stream] = combined.slice(-(marker.length - 1));
            const chunk = Buffer.from(text);
            const remaining = Math.max(0, 32 * 1024 * 1024 - logBytes[stream]);
            if (chunk.length > remaining) outputTruncated.add(stream);
            if (remaining) {
              const kept = chunk.subarray(0, remaining);
              appendFileSync(join(folder, `full.${stream}.log`), kept);
              logBytes[stream] += kept.length;
            }
            return undefined;
          },
        }),
    })
    .then((observation) => {
      if (observation.kind === "completed") {
        fullExitCode = observation.result.code;
        code = observation.result.code;
      } else {
        const error = observation.error;
        if (error instanceof CommandFailure) {
          fullExitCode = error.code ?? null;
          fullFailureExecution = error.execution;
        }
        failure = error instanceof Error ? error.message : String(error);
        code = interrupted ?? 1;
        if (!observation.safeToDispose) controller.abort("Full test command settlement was not confirmed");
      }
    })
    .finally(() => {
      finished = true;
    });

  let samples = 0;
  let sampleBytes = 0;
  let peakRssBytes = 0;
  let peakProcesses = 0;
  let peakRollingCpuPercent: number | undefined;
  let afterExitProcesses: ReturnType<SampledProcessTree["select"]>["processes"] | undefined;

  const sample = async () => {
    try {
      const plan = processMetricsPlan(process.platform);
      const tree = new SampledProcessTree(child!.pid);
      while (!controller.signal.aborted) {
        const final = finished;
        const tick = performance.now();
        try {
          const observed = await settlements.observe({
            run: () =>
              runCommand(plan.argv, {
                cwd: ROOT,
                env: { ...owned.env, ...plan.env },
                timeoutMs: 3_000,
                signal: controller.signal,
              }),
          });
          if (observed.kind === "rejected") {
            if (observed.error instanceof CommandFailure && observed.error.execution) {
              samplerFailures.push({
                sample: samples + 1,
                phase: final ? "after-exit" : "running",
                execution: observed.error.execution,
              });
            }
            if (!observed.safeToDispose) {
              const detail = observed.error instanceof Error ? observed.error.message : String(observed.error);
              errors.push(`Process sampler settlement was not confirmed: ${detail}`);
              // The full command is still an actual bounded owner; stop it before doing further sampling.
              controller.abort("Process sampler settlement was not confirmed");
              return;
            }
            throw observed.error;
          }
          const observation = observed.result;
          if (observation.code !== 0) throw new Error(`Process sampler exited ${observation.code}.`);
          const selected = tree.select(parseProcessMetrics(observation.stdout, plan.format));
          if (final) afterExitProcesses = selected.processes;
          const rssBytes = selected.processes.reduce((total, row) => total + row.rssBytes, 0);
          const cpuPercent = selected.processes.every((row) => row.cpuPercent !== undefined)
            ? selected.processes.reduce((total, row) => total + row.cpuPercent!, 0)
            : undefined;
          peakRssBytes = Math.max(peakRssBytes, rssBytes);
          peakProcesses = Math.max(peakProcesses, selected.processes.length);
          if (cpuPercent !== undefined) peakRollingCpuPercent = Math.max(peakRollingCpuPercent ?? 0, cpuPercent);
          samples++;
          const encoded =
            JSON.stringify({
              at: Date.now(),
              elapsedMs: performance.now() - began,
              phase: final ? "after-exit" : "running",
              ...selected,
              rssBytes,
              cpuPercent,
            }) + "\n";
          sampleBytes += Buffer.byteLength(encoded);
          if (sampleBytes > 32 * 1024 * 1024) {
            errors.push("Process samples reached the32MiB observation limit; further samples were not recorded.");
            return;
          }
          appendFileSync(join(folder, "samples.jsonl"), encoded);
        } catch (error) {
          if (!controller.signal.aborted) errors.push(error instanceof Error ? error.message : String(error));
        }
        if (final) break;
        const remaining = Math.max(0, 1_000 - (performance.now() - tick));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([full, new Promise<void>((done) => { timer = setTimeout(done, remaining); })]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };

  try {
    await Promise.all([full, child ? sample() : Promise.resolve()]);
    let rootUsage: unknown;
    try {
      rootUsage = resourceUsageRecord(child?.resourceUsage());
    } catch {
      /* An unavailable counter remains absent. */
    }
    const disposed = await dispose();
    const diagnosticCode = interrupted ?? (disposed ? (code ?? 1) : 1);
    writeFixtureJson(
      join(folder, "run.json"),
      {
        kind: "resource-diagnostic",
        deliveryEligible: false,
        command: "bun run test",
        workers: "unchanged defaults",
        code: diagnosticCode,
        fullExitCode,
        failure,
        fullFailureExecution,
        ms: performance.now() - began,
        instrumentation: { gitCallers: process.env.PETRINA_TEST_RESOURCE_GIT_CALLERS === "1" },
        privateEnvironment: disposed ? "disposable" : "retained",
        environment: {
          platform: process.platform,
          arch: process.arch,
          bun: Bun.version,
          logicalCpus: cpus().length,
        },
        rootUsage,
        observerErrors,
        outputTruncated: [...outputTruncated],
        afterExitProcesses,
        sampling: {
          intervalMs: 1_000,
          samples,
          errors,
          ...(samplerFailures.length ? { commandFailures: samplerFailures } : {}),
          ...(samples
            ? {
              peakAggregateRssBytes: peakRssBytes,
              peakObservedProcessEntries: peakProcesses,
              peakRollingCpuPercent,
            }
            : {}),
          limits: SAMPLING_LIMITS,
        },
      },
      2,
    );
    if (settlements.safeToDispose) await report(folder);
    else {
      if (failure !== undefined) console.error(failure);
      for (const error of errors) console.error(error);
    }
    process.exitCode = interrupted ?? diagnosticCode;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (!(await dispose())) {
      console.error(`Test command settlement was not confirmed; private files retained at ${owned.env.TMPDIR}`);
      if (disposalFailure) console.error(disposalFailure.error);
      if (interrupted === undefined) process.exitCode = 1;
    }
  }
}
