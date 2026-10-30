import { isGitCaller } from "./git-callers.js";

export interface CaseCost {
  id: string;
  file: string;
  name: string;
  wallMs?: number;
  outcome?: string;
  runner: "bun" | "vitest";
  launches: number;
  observedChildCpuUs?: number;
  largestObservedChildRssBytes?: number;
  observedExits: number;
  cpuReadings: number;
  rssReadings: number;
  reportedHeapBytes?: number;
}

interface FileCost {
  file: string;
  cases: number;
  nativeCases: number;
  callbackReadings: number;
  callbackMsSum?: number;
  launches: number;
  observedExits: number;
  cpuReadings: number;
  rssReadings: number;
  observedChildCpuUs?: number;
  largestObservedChildRssBytes?: number;
}

const REPORT_LIMITS = [
  "Launch counts cover instrumented Bun and node:child_process calls, not every descendant's internal launches.",
  "Hooks and module setup may be unattributed. Case duration excludes surrounding hooks. File callback sums can overlap and are not file elapsed time.",
  "Child rusage can include its descendants and must not be summed as exclusive whole-suite CPU.",
  "Largest child RSS is one child's high-water mark, not a case's aggregate peak.",
  "Shared worker CPU and memory are not attributed to individual tests.",
  "Profiling changes execution cost. These results cannot authorize delivery.",
];

/** CPU is child rusage only; a shared native worker's own CPU/heap cannot be assigned to one test. */
export class ResourceSummary {
  private readonly cases = new Map<string, CaseCost>();
  private readonly launches = new Set<string>();
  private readonly exits = new Set<string>();
  private readonly programs = new Map<string, number>();
  private readonly git = new Map<string, number>();
  private readonly gitCallers = new Map<string, { launches: number; operations: Map<string, number> }>();
  private readonly ended = new Set<string>();
  private truncated = false;
  private unattributed = 0;
  private readonly childrenWithPid = new Set<string>();
  private readonly failedStarts = new Set<string>();
  private readonly files = new Set<string>();
  private readonly instanceCases = new Map<string, Set<CaseCost>>();

  accept(row: Record<string, unknown>): void {
    if (row.kind === "truncated") this.truncated = true;
    if (row.kind === "file-end" && typeof row.file === "string") {
      this.files.add(row.file);
      // Completion records provide the actual worker entry even in older logs with formatted stack labels.
      if (typeof row.instance === "string") {
        for (const cost of this.instanceCases.get(row.instance) ?? []) cost.file = row.file;
      }
    }
    if (row.kind === "spawn-error" && typeof row.id === "string") this.failedStarts.add(row.id);
    const owner = row.case as { id?: string; file?: string; name?: string } | undefined;
    const cost =
      owner?.id && typeof owner.file === "string" && typeof owner.name === "string"
        ? (this.cases.get(owner.id) ?? {
          id: owner.id,
          file: owner.file,
          name: owner.name,
          runner: row.runner === "vitest" ? ("vitest" as const) : ("bun" as const),
          launches: 0,
          observedExits: 0,
          cpuReadings: 0,
          rssReadings: 0,
        })
        : undefined;
    if (cost) this.cases.set(cost.id, cost);
    if (cost && typeof row.instance === "string" && ["case-start", "case-end"].includes(row.kind as string)) {
      const entries = this.instanceCases.get(row.instance) ?? new Set<CaseCost>();
      entries.add(cost);
      this.instanceCases.set(row.instance, entries);
    }
    if (row.kind === "case-end" && cost) {
      if (typeof row.wallMs === "number" && Number.isFinite(row.wallMs) && row.wallMs >= 0) {
        cost.wallMs = row.wallMs;
      }
      cost.outcome = typeof row.outcome === "string" ? row.outcome : "unknown";
      if (
        typeof row.reportedHeapBytes === "number"
        && Number.isFinite(row.reportedHeapBytes)
        && row.reportedHeapBytes >= 0
      ) {
        cost.reportedHeapBytes = row.reportedHeapBytes;
      }
      this.ended.add(cost.id);
    }
    if (row.kind === "spawn" && typeof row.id === "string" && !this.launches.has(row.id)) {
      this.launches.add(row.id);
      if (typeof row.child === "number" && Number.isSafeInteger(row.child) && row.child > 0) {
        this.childrenWithPid.add(row.id);
      }
      if (cost) cost.launches++;
      else this.unattributed++;
      const program = typeof row.program === "string" ? row.program : "unknown";
      this.programs.set(program, (this.programs.get(program) ?? 0) + 1);
      if (program === "git") {
        const operation = typeof row.operation === "string" ? row.operation : "unknown";
        this.git.set(operation, (this.git.get(operation) ?? 0) + 1);
        if (isGitCaller(row.caller)) {
          const caller = this.gitCallers.get(row.caller) ?? { launches: 0, operations: new Map<string, number>() };
          caller.launches++;
          caller.operations.set(operation, (caller.operations.get(operation) ?? 0) + 1);
          this.gitCallers.set(row.caller, caller);
        }
      }
    }
    if (row.kind === "exit" && typeof row.id === "string" && !this.exits.has(row.id)) {
      this.exits.add(row.id);
      if (cost) cost.observedExits++;
      const usage = row.usage as { userUs?: number; systemUs?: number; totalUs?: number; maxRssBytes?: number } | undefined;
      if (cost && usage) {
        const cpu =
          typeof usage.totalUs === "number" && Number.isFinite(usage.totalUs) && usage.totalUs >= 0
            ? usage.totalUs
            : typeof usage.userUs === "number"
                && usage.userUs >= 0
                && typeof usage.systemUs === "number"
                && usage.systemUs >= 0
              ? usage.userUs + usage.systemUs
              : NaN;
        if (Number.isFinite(cpu) && cpu >= 0) {
          cost.observedChildCpuUs = (cost.observedChildCpuUs ?? 0) + cpu;
          cost.cpuReadings++;
        }
        if (typeof usage.maxRssBytes === "number" && Number.isFinite(usage.maxRssBytes) && usage.maxRssBytes >= 0) {
          cost.largestObservedChildRssBytes = Math.max(cost.largestObservedChildRssBytes ?? 0, usage.maxRssBytes);
          cost.rssReadings++;
        }
      }
    }
  }

  report(limit = 20) {
    const values = [...this.cases.values()];
    const files = new Map<string, FileCost>();
    for (const cost of values) {
      const entry = files.get(cost.file) ?? {
        file: cost.file,
        cases: 0,
        nativeCases: 0,
        callbackReadings: 0,
        launches: 0,
        observedExits: 0,
        cpuReadings: 0,
        rssReadings: 0,
      };
      entry.cases++;
      if (cost.runner === "bun") entry.nativeCases++;
      if (cost.wallMs !== undefined) {
        entry.callbackMsSum = (entry.callbackMsSum ?? 0) + cost.wallMs;
        entry.callbackReadings++;
      }
      entry.launches += cost.launches;
      entry.observedExits += cost.observedExits;
      entry.cpuReadings += cost.cpuReadings;
      entry.rssReadings += cost.rssReadings;
      if (cost.observedChildCpuUs !== undefined) {
        entry.observedChildCpuUs = (entry.observedChildCpuUs ?? 0) + cost.observedChildCpuUs;
      }
      if (cost.largestObservedChildRssBytes !== undefined) {
        entry.largestObservedChildRssBytes = Math.max(
          entry.largestObservedChildRssBytes ?? 0,
          cost.largestObservedChildRssBytes,
        );
      }
      files.set(cost.file, entry);
    }

    const top = (value: (cost: CaseCost) => number | undefined) =>
      [...values]
        .filter((cost) => value(cost) !== undefined)
        .sort((a, b) => value(b)! - value(a)! || a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
        .slice(0, limit);

    const topFiles = (value: (cost: FileCost) => number | undefined) =>
      [...files.values()]
        .filter((cost) => value(cost) !== undefined)
        .sort((a, b) => value(b)! - value(a)! || a.file.localeCompare(b.file))
        .slice(0, limit);

    const gitLaunchesWithCaller = [...this.gitCallers.values()].reduce((sum, caller) => sum + caller.launches, 0);

    return {
      observedLaunchCalls: this.launches.size,
      callsWithReportedChildPid: this.childrenWithPid.size,
      unattributedLaunches: this.unattributed,
      failedLaunchCalls: this.failedStarts.size,
      completedFiles: [...this.files].sort(),
      launchesWithoutObservedExit: [...this.launches].filter((id) => !this.exits.has(id)).length,
      observedCases: values.length,
      unfinishedCases: values.filter((cost) => !this.ended.has(cost.id)).length,
      truncated: this.truncated,
      programs: Object.fromEntries([...this.programs].sort((a, b) => b[1] - a[1])),
      gitOperations: Object.fromEntries([...this.git].sort((a, b) => b[1] - a[1])),
      gitLaunchesWithCaller,
      gitLaunchesWithoutCaller: (this.programs.get("git") ?? 0) - gitLaunchesWithCaller,
      topGitCallers: [...this.gitCallers]
        .sort(([a, x], [b, y]) => y.launches - x.launches || a.localeCompare(b))
        .slice(0, limit)
        .map(([caller, value]) => ({
          caller,
          launches: value.launches,
          operations: Object.fromEntries(value.operations),
        })),
      topByDuration: top((cost) => cost.wallMs),
      topByLaunches: top((cost) => (cost.runner === "bun" ? cost.launches : undefined)),
      topByObservedChildCpu: top((cost) => cost.observedChildCpuUs),
      topByLargestObservedChildRss: top((cost) => cost.largestObservedChildRssBytes),
      topByReportedHeap: top((cost) => cost.reportedHeapBytes),
      topFilesByCallbackTimeSum: topFiles((cost) => cost.callbackMsSum),
      topFilesByLaunches: topFiles((cost) => (cost.nativeCases ? cost.launches : undefined)),
      topFilesByObservedChildCpu: topFiles((cost) => cost.observedChildCpuUs),
      topFilesByLargestObservedChildRss: topFiles((cost) => cost.largestObservedChildRssBytes),
      limits: REPORT_LIMITS,
    };
  }
}
