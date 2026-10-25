import { expect, it } from "bun:test";
import { parseProcessMetrics, processMetricsPlan, SampledProcessTree, type ProcessMetric } from "../../../src/process-metrics.js";

const row = (pid: number, ppid: number, born = "one"): ProcessMetric => ({ pid, ppid, born, program: "fixture", rssBytes: 1024 });

it("parses ps CPU as a rolling percentage and converts KiB to bytes without losing spaced program paths", () => {
  expect(parseProcessMetrics("  12 1 125.5 2048 Sun Oct 25 12:01:02 2026 /a directory/bun\n", "ps")).toEqual([
    { pid: 12, ppid: 1, cpuPercent: 125.5, rssBytes: 2097152, born: "Sun Oct 25 12:01:02 2026", program: "bun" },
  ]);
});

it("keeps Windows cumulative CPU separate from the unavailable percentage", () => {
  expect(parseProcessMetrics(JSON.stringify({ pid: 12, ppid: 1, rssBytes: "2097152", cpuMs: 12.5, born: "2026-10-25T09:00:00Z", program: "bun.exe" }), "windows"))
    .toEqual([{ pid: 12, ppid: 1, rssBytes: 2097152, cpuMs: 12.5, born: "2026-10-25T09:00:00Z", program: "bun.exe" }]);
});

for (const invalid of [null, false, "", "unknown"]) it(`refuses missing Windows counters instead of inventing zero: ${String(invalid)}`, () => {
  const value = { pid: 12, ppid: 1, rssBytes: 2048, cpuMs: 0, born: "2026-10-25T09:00:00Z", program: "bun" };
  expect(() => parseProcessMetrics(JSON.stringify({ ...value, rssBytes: invalid }), "windows")).toThrow("Incomplete");
  expect(() => parseProcessMetrics(JSON.stringify({ ...value, cpuMs: invalid }), "windows")).toThrow("Incomplete");
  expect(() => parseProcessMetrics(JSON.stringify({ ...value, pid: invalid }), "windows")).toThrow("Incomplete");
  expect(() => parseProcessMetrics(JSON.stringify({ ...value, ppid: invalid }), "windows")).toThrow("Incomplete");
});

it("refuses malformed and duplicate process observations", () => {
  expect(() => parseProcessMetrics("12 1 unavailable\n", "ps")).toThrow("Malformed");
  const ps = "12 1 0 4 Sun Oct 25 12:01:02 2026 bun\n";
  expect(() => parseProcessMetrics(ps + ps, "ps")).toThrow("Duplicate");
  expect(() => new SampledProcessTree(12).select([row(12, 1), row(12, 1, "other")])).toThrow("Duplicate");
});

it("associates descendants transitively and retains an already observed orphan", () => {
  const tree = new SampledProcessTree(10);
  expect(tree.select([row(30, 20), row(99, 1), row(20, 10), row(10, 1)]).processes.map(item => item.pid)).toEqual([30, 20, 10]);
  expect(tree.select([row(30, 1), row(99, 1)])).toEqual({ rootPresent: false, processes: [row(30, 1)] });
});

it("does not re-adopt a PID after its birth changed or it disappeared from a complete observation", () => {
  const tree = new SampledProcessTree(10);
  tree.select([row(10, 1), row(20, 10)]);
  expect(tree.select([row(10, 1), row(20, 1, "new")]).processes.map(item => item.pid)).toEqual([10]);
  tree.select([]);
  expect(tree.select([row(10, 1), row(20, 10)])).toEqual({ rootPresent: false, processes: [] });
});

it("isolates native observation commands and rejects unsupported platforms", () => {
  expect(processMetricsPlan("linux")).toEqual(processMetricsPlan("darwin"));
  expect(processMetricsPlan("win32").argv).toContain("-NonInteractive");
  expect(processMetricsPlan("win32").format).toBe("windows");
  expect(() => processMetricsPlan("aix")).toThrow("not implemented");
});
