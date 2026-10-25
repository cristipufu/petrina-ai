import { expect, it } from "bun:test";
import { runCommand } from "@petrina/test-support/commands";
import { processMetricsPlan, parseProcessMetrics } from "../../../src/process-metrics.js";

it("observes the actual running worker through its platform's read-only adapter", async () => {
  const plan = processMetricsPlan(process.platform);
  const result = await runCommand(plan.argv, { env: { ...process.env, ...plan.env } });
  expect(result.code, result.stderr).toBe(0);
  const own = parseProcessMetrics(result.stdout, plan.format).find(row => row.pid === process.pid);
  expect(own?.pid).toBe(process.pid); expect(own?.born).toBeTruthy();
  expect(own?.rssBytes).toBeGreaterThan(0);
  expect(typeof own?.cpuPercent === "number" || typeof own?.cpuMs === "number").toBe(true);
});
