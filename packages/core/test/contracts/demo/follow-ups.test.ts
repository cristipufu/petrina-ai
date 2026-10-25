import { describe, expect, it } from "vitest";
import { createDemo, createPortfolioDemo } from "../../../src/demo.js";

describe("sample boards", () => {
  it("shows one backlog card for two worded reports and leaves one follow-up unmatched", () => {
    for (const demo of [createDemo(1), createPortfolioDemo(1)]) {
      const card = demo.state.tasks.find((task) => task.id === "footer-follow-up");

      expect(card?.state).toBe("backlog");
      expect(card?.followUp?.reports).toHaveLength(2);
      expect(new Set(card!.followUp!.reports.map((report) => report.text)).size).toBe(2);
      const source = demo.state.tasks.find((task) => task.id === card!.followUp!.reports[0]!.taskId);
      expect(source?.state).toBe("done");
      const tracked = source!.findings.filter((finding) => finding.tracking && "taskId" in finding.tracking);
      expect(tracked.map((finding) => ("taskId" in finding.tracking! ? finding.tracking.taskId : ""))).toEqual(["footer-follow-up", "footer-follow-up"]);
      expect(source!.findings.find((finding) => finding.tracking && "reason" in finding.tracking && finding.tracking.reason === "unmatched")?.text).toContain("copyright");
    }
  });
});
