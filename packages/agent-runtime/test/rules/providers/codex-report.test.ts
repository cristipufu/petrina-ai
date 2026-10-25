import { expect, it } from "bun:test";
import { codexReports } from "../../../src/codex-report.js";
const soon = Math.floor(Date.now() / 1000) + 3600;

  it("maps each window by its length, with the reset time in milliseconds, and the status by how much is used", () => {
    const result = { rateLimits: { primary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: soon }, secondary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: null } } };
    expect(codexReports(result)).toEqual([
      { toolId: "codex", kind: "codex:primary", windowMinutes: 10080, status: "allowed", utilization: 0.88, resetsAt: soon * 1000 },
      { toolId: "codex", kind: "codex:secondary", windowMinutes: 300, status: "allowed", utilization: 0.125 },
    ]);
    expect(codexReports({ rateLimits: { primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: soon }, secondary: null } })[0]).toMatchObject({ status: "allowed_warning" });
    expect(codexReports({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: soon } } })[0]).toMatchObject({ status: "rejected", utilization: 1 });
    expect(codexReports({})).toEqual([]);
    expect(codexReports(undefined)).toEqual([]);
  });
