import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, lines, close } = reviewJourneyFixtures();
afterAll(close);
describe.concurrent("reviews that converge", () => {
it("has fresh agents vote on an Important finding, the builder answer it, and reviews only what changed next round", async () => {
    const { task, fakes, atOnce, voters } = await untilDelivery({ reviewer: "important" });

    const important = task.findings.filter((finding) => finding.severity === "blocking");
    expect(important.map((finding) => finding.text)).toEqual(["The greeting is missing on the welcome page."]);
    // Raised on one tool only, so a fresh pair voted on it, and each said it is real: no third answer.
    expect(important[0]!.votes?.map((vote) => vote.verdict)).toEqual(Array(voters).fill("real"));
    expect(important[0]!.verification).toMatchObject({ verdict: "real" });
    expect(important[0]!.answer).toMatchObject({ fixed: true, text: "Fixed it." });
    expect(important[0]!.status).toBe("fixed");
    const firstReview = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
    const reported = firstReview.result?.findings?.find((finding) => finding.id === important[0]!.id);
    expect(reported?.text).toBe("The greeting is missing on the welcome page.");
    expect(reported?.status).toBe("open");
    expect(reported?.answer).toBeUndefined();
    expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(3);

    expect(fakes.openings("verifier")).toHaveLength(voters);
    // The two reviewers looked at the change at once, and so did the voters, up to the pool of three.
    expect(atOnce).toBe(Math.max(2, Math.min(3, voters)));
    // Each worked in a copy of its own, never the task's, and every copy is gone afterwards.
    const copies = [...fakes.openings("code reviewer").slice(0, 2), ...fakes.openings("verifier")].map((text) => /Your working copy is (.+?), on branch/.exec(text)?.[1]);
    expect(new Set(copies).size).toBe(2 + voters);
    for (const copy of copies) {
      expect(copy).not.toBe(task.worktree);
      expect(existsSync(copy!)).toBe(false);
    }
    expect(fakes.openings("verifier")[0]).toContain("is yours alone");
    expect(lines(task)).toContain("Sent back to the builder: 1 important");
    expect(fakes.openings("builder")[1]).toContain("Review findings (answer every one by id; fix every Important one)");

    // Reviews compare against the base commit pinned when the working copy was made, not a ref an agent could move.
    expect(task.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fakes.openings("code reviewer")[0]).toContain(`git diff ${task.baseSha}...HEAD`);

    // Round two looks only at what changed since round one.
    expect(task.reviewedSha).toMatch(/^[0-9a-f]{40}$/);
    const second = fakes.openings("code reviewer").filter((text) => text.includes("This is review round 2"));
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]).toContain(`git diff ${task.reviewedSha}..HEAD`);
    const secondReview = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
    expect(secondReview.result?.findings?.find((finding) => finding.id === important[0]!.id)?.status).toBe("fixed");
    expect(important[0]!.status).toBe("fixed");
    expect(lines(task).some((line) => line.startsWith("Review passed: "))).toBe(true);
  });

});
describe.concurrent("reviewers at once, then a vote", () => {
it("keeps blind reports separate and verifies each claim without inferring agreement from prose", async () => {
    const { task, fakes, voters } = await untilDelivery({ reviewer: "important-twice" });
    const important = task.findings.filter((finding) => finding.text.toLowerCase().includes("greeting is missing"));
    expect(important).toHaveLength(2);
    expect(new Set(important.map((finding) => finding.id)).size).toBe(2);
    for (const finding of important) {
      expect(finding.status).toBe("fixed"); expect(finding.confirmedBy).toEqual([]);
      expect(finding.verification?.verdict).toBe("real");
      expect(fakes.openings("verifier")[0]).toContain(`[${finding.id}]`);
    }
    expect(fakes.openings("verifier")).toHaveLength(voters);
    expect(lines(task)).toContain("Sent back to the builder: 2 important");
  });

});
