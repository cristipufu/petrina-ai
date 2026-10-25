import { expect, it } from "bun:test";
import { ResourceSummary } from "../../../src/resources/summary.js";

const owner = (id: string) => ({ id, file: `${id}.test.ts`, name: `case ${id}` });
it("ranks elapsed duration and launches independently rather than treating one as the other", () => {
  const result = new ResourceSummary();
  result.accept({ kind: "case-end", case: owner("slow"), wallMs: 200, outcome: "passed" });
  result.accept({ kind: "case-end", case: owner("busy"), wallMs: 20, outcome: "passed" });
  for (const id of ["one", "two"]) result.accept({ kind: "spawn", id, program: "git", operation: "status", case: owner("busy") });
  const report = result.report();
  expect(report.topByDuration[0]?.id).toBe("slow");
  expect(report.topByLaunches[0]?.id).toBe("busy");
  expect(report.observedLaunchCalls).toBe(2); expect(report.gitOperations).toEqual({ status: 2 });
  expect(report.launchesWithoutObservedExit).toBe(2);
});

it("retains unknown ownership and incomplete observations without assigning them to another case", () => {
  const result = new ResourceSummary();
  result.accept({ kind: "spawn", id: "module-setup", program: "bun" });
  result.accept({ kind: "case-start", case: owner("unfinished") });
  result.accept({ kind: "truncated" });
  expect(result.report()).toMatchObject({ unattributedLaunches: 1, observedCases: 1, unfinishedCases: 1, truncated: true });
});

it("counts a repeated event once and preserves case child CPU and largest child RSS as separate metrics", () => {
  const result = new ResourceSummary();
  const launch = { kind: "spawn", id: "child", case: owner("one"), program: "bun" };
  const exit = { kind: "exit", id: "child", case: owner("one"), usage: { userUs: 300, systemUs: 40, maxRssBytes: 1024 } };
  result.accept(launch); result.accept(launch); result.accept(exit); result.accept(exit);
  result.accept({ kind: "exit", id: "other-child", case: owner("one"), usage: { userUs: 20, systemUs: 10, maxRssBytes: 512 } });
  expect(result.report().topByObservedChildCpu[0]).toMatchObject({ launches: 1, observedExits: 2, cpuReadings: 2, rssReadings: 2, observedChildCpuUs: 370, largestObservedChildRssBytes: 1024 });
  expect(result.report().launchesWithoutObservedExit).toBe(0);
});

it("does not fabricate costs from unavailable or nonfinite readings", () => {
  const result = new ResourceSummary();
  result.accept({ kind: "case-end", case: owner("one"), wallMs: -1 });
  result.accept({ kind: "exit", id: "bad", case: owner("one"), usage: { userUs: NaN, systemUs: 1, maxRssBytes: Infinity } });
  expect(result.report().topByDuration).toEqual([]);
  expect(result.report().topByObservedChildCpu).toEqual([]);
  expect(result.report().topByLargestObservedChildRss).toEqual([]);
});

it("rejects negative child CPU components even when their sum would look plausible", () => {
  const result = new ResourceSummary();
  result.accept({ kind: "exit", id: "bad", case: owner("one"), usage: { userUs: -100, systemUs: 200 } });
  expect(result.report().topByObservedChildCpu).toEqual([]);
});

it("keeps an uninstrumented Vitest case out of the native launch ranking", () => {
  const result = new ResourceSummary();
  result.accept({ kind: "case-end", runner: "vitest", case: owner("vitest"), wallMs: 12, reportedHeapBytes: 2048 });
  expect(result.report().topByDuration[0]?.runner).toBe("vitest");
  expect(result.report().topByLaunches).toEqual([]);
  expect(result.report().topByReportedHeap[0]?.reportedHeapBytes).toBe(2048);
});
