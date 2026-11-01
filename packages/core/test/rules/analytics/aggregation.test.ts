import { NOW, MIN, HOUR, task, state, turn, line, logWith } from '../../fixtures/analytics.js';
import { describe, expect, it } from "vitest";

import { figureText, nearestLimitWords, nextReset } from "../../../src/numbers.js";

import { periodRange, usageView } from "../../../src/analytics.js";

import { CHANGED_LABEL, NOT_CONFIRMED_LABEL, type WorkMoment } from "../../../src/worklog.js";

describe("Analytics", () => {
  const s = state([task("g", "shop"), task("h", "notes"), task("r", "gone")]);

  const opus = turn({ taskId: "g", roleId: "builder", profileId: "opus-high" });

  const fallback = turn({ taskId: "g", roleId: "code-reviewer", profileId: "opus-high", modelChangedTo: "Sonnet 5.5", stageId: "g:review", stageKind: "review-chain" });

  const unconfirmed = turn({ taskId: "h", productId: "notes", roleId: "builder", profileId: "sonnet-medium", modelRan: undefined, modelRanName: undefined, effortRan: undefined });

  const codex = turn({ taskId: "h", productId: "notes", roleId: "code-reviewer", profileId: "sol-xhigh", stageId: "h:review", stageKind: "review-chain" });

  const rerouted = turn({ taskId: "h", productId: "notes", roleId: "code-reviewer", profileId: "sol-high", modelChangedTo: "gpt-6.1-mini", stageId: "h:review", stageKind: "review-chain", round: 2 });

  const removed = turn({ taskId: "r", productId: "gone", roleId: "builder", profileId: "sol-high", helpers: 1, mainOnly: true });

  const noBreakdown = turn({ taskId: "g", roleId: "planner", profileId: "sonnet-medium", stageId: "g:plan", stageKind: "plan", mainOnly: true });

  const log = logWith([
    { turn: opus, lines: [line(opus.id, "claude-opus-5-5", 9000), line(opus.id, "claude-haiku-5-5", 1000)] },
    { turn: fallback, lines: [line(fallback.id, "claude-opus-5-5", 4000), line(fallback.id, "claude-sonnet-5-5", 6000)] },
    { turn: unconfirmed, lines: [line(unconfirmed.id, "claude-sonnet-5-5", 10_000)] },
    { turn: codex, lines: [line(codex.id, "gpt-6.1-sol", 10_000)] },
    { turn: rerouted, lines: [line(rerouted.id, "gpt-6.1-sol", 10_000, { changed: true })] },
    { turn: removed, lines: [line(removed.id, "gpt-6.1-sol", 10_000)] },
    { turn: noBreakdown, lines: [line(noBreakdown.id, "Sonnet 5.5", 10_000)] },
  ]);

  log.recordProduct({ id: "gone", name: "Old app", removedAt: NOW - 24 * HOUR });

  const view = usageView(log, { view: "analytics", period: "7d" }, { now: NOW, state: s });

  it("gives the headline, the chart and the tool, role, product and task splits", () => {
    expect(view.headline).toEqual({ tokens: { value: 70_000, atLeast: false }, time: { value: 70 * MIN, atLeast: false }, turns: 7, tasks: 3 });
    expect(view.chart.buckets).toHaveLength(7);
    const today = view.chart.buckets.at(-1)!;
    expect(today.tokens).toEqual({ "claude-code": 40_000, codex: 30_000 });
    expect(view.byTool.map((entry) => [entry.label, entry.tokens.value])).toEqual([
      ["Claude Code", 40_000],
      ["Codex", 30_000],
    ]);
    expect(view.byRole.map((entry) => entry.label)).toEqual(["Builder", "Code reviewer", "Planner"]);
    expect(view.byProduct?.find((entry) => entry.productId === "gone")).toMatchObject({ label: "Old app", note: "removed", tokens: { value: 10_000 } });
    expect(view.byTask).toHaveLength(3);
    expect(view.byTool[0]!.detail).toEqual({ input: 4000, cacheRead: 32_000, cacheWrite: 2000, output: 2000 });
    // Only all-products views split by product.
    expect(usageView(log, { view: "analytics", period: "7d", productId: "shop" }, { now: NOW, state: s }).byProduct).toBeUndefined();
  });

  it("splits by model exactly as reported, and puts time only with the agent's own model", () => {
    const byLabel = new Map(view.byModel.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Opus 5.5")).toMatchObject({ tokens: { value: 13_000 }, time: { value: 10 * MIN } });
    // A model that only appeared inside another model's turns has tokens but no time of its own, never zero.
    expect(byLabel.get("Haiku 5.5")?.time.value).toBeUndefined();
    expect(figureText(byLabel.get("Haiku 5.5")!.time, "time")).toBe("not reported");
    // The planner's main figure sits under its confirmed model name, and so does its time.
    expect(byLabel.get("Sonnet 5.5")).toMatchObject({ tokens: { value: 26_000 }, time: { value: 10 * MIN } });
    expect(byLabel.get(NOT_CONFIRMED_LABEL)).toMatchObject({ time: { value: 10 * MIN } });
    expect(byLabel.get(NOT_CONFIRMED_LABEL)?.tokens.value).toBeUndefined();
    // A Claude fallback's time and a Codex reroute's tokens and time go on the "changed" line.
    expect(byLabel.get(CHANGED_LABEL)).toMatchObject({ tokens: { value: 10_000 }, time: { value: 20 * MIN } });
    expect(byLabel.get("gpt-6.1-sol")).toMatchObject({ tokens: { value: 20_000 }, time: { value: 20 * MIN } });
    for (const entry of view.byModel) expect(entry.label).not.toMatch(/high|medium|xhigh|effort/);
  });

  it("only credits a profile with stages that ran on its own model and effort", () => {
    const reviews: WorkMoment[] = [
      { id: "v1", at: NOW - HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round: 1, roleId: "code-reviewer", profileId: "opus-high", count: 2, blocking: 1 },
      { id: "v2", at: NOW - HOUR, kind: "verdict", taskId: "h", productId: "notes", stageId: "h:review", round: 1, roleId: "code-reviewer", profileId: "sol-xhigh", count: 1, blocking: 1 },
    ];
    const withVerdicts = logWith(
      [
        { turn: fallback, lines: [] },
        { turn: codex, lines: [] },
      ],
      reviews,
    );
    const squad = usageView(withVerdicts, { view: "analytics", period: "7d" }, { now: NOW, state: s }).squad;
    const rows = squad.details.reviewers;
    expect(rows.find((row) => row.label === "Codex · sol · xhigh")).toMatchObject({ credited: true, stages: 1, rounds: 1, blocking: 1, sentBack: 1 });
    // The Opus reviewer fell back to Sonnet, so that review is listed under what ran, not under the Opus profile.
    expect(rows.some((row) => row.label === "Claude Code · Opus 5.5 · high")).toBe(false);
    expect(rows.find((row) => row.label.includes("Sonnet 5.5"))).toMatchObject({ credited: false, blocking: 1 });
    expect(squad.details.settingsLine).toContain("1 agent stage ran on settings other than those asked for");
  });

  it("gives no profile credit for a stage when any of its rounds ran on other settings", () => {
    const review = { taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review", stageKind: "review-chain" } as const;
    const asAsked = turn({ ...review, round: 1 });
    const offRound = turn({ ...review, round: 2, modelRan: "sonnet", modelRanName: "Sonnet 5.5" });
    const verdicts: WorkMoment[] = [1, 2].map((round) => ({ id: `w${round}`, at: NOW - HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round, roleId: "code-reviewer", profileId: "opus-high", count: 1, blocking: 1 }));
    const squad = usageView(logWith([{ turn: asAsked }, { turn: offRound }], verdicts), { view: "analytics", period: "7d" }, { now: NOW, state: s }).squad;
    const rows = squad.details.reviewers;
    // Round 1 alone ran as asked, but the stage didn't: neither round counts for the Opus profile.
    expect(rows.some((row) => row.credited)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credited: false, stages: 1, rounds: 2, blocking: 2 });
    expect(rows[0]!.label).toContain("Sonnet 5.5");
    expect(squad.details.settingsLine).toContain("1 agent stage ran on settings other than those asked for");
  });

  it("judges a stage on every round, also the ones before the period", () => {
    const review = { taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review", stageKind: "review-chain" } as const;
    // Yesterday's round ran on Sonnet; today's ran on the Opus profile as asked.
    const yesterday = turn({ ...review, round: 1, startedAt: NOW - 20 * HOUR, modelRan: "sonnet", modelRanName: "Sonnet 5.5" });
    const todayRound = turn({ ...review, round: 2 });
    const verdicts: WorkMoment[] = [
      { id: "y1", at: NOW - 19 * HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round: 1, roleId: "code-reviewer", profileId: "opus-high", count: 1, blocking: 1 },
      { id: "y2", at: NOW - HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round: 2, roleId: "code-reviewer", profileId: "opus-high", count: 0, blocking: 0 },
    ];
    const squad = usageView(logWith([{ turn: yesterday }, { turn: todayRound }], verdicts), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad;
    const rows = squad.details.reviewers;
    // Only today's round is in the period, but the stage didn't run on the profile's settings throughout.
    expect(rows.some((row) => row.credited)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credited: false, stages: 1, rounds: 1, blocking: 0 });
    expect(rows[0]!.label).toContain("Sonnet 5.5");
    expect(squad.details.settingsLine).toContain("1 agent stage ran on settings other than those asked for");
  });

  it("keeps unknown profile time unknown, and marks recorded time mixed with a lost turn as at least", () => {
    const review = { taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review", stageKind: "review-chain" } as const;
    const lost = turn({ ...review, round: 2, end: "lost", endedAt: undefined, workMs: undefined, tokens: undefined });
    const onlyLost = usageView(logWith([{ turn: lost }]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(onlyLost.time).toEqual({ atLeast: true, unknown: true });
    expect(figureText(onlyLost.time, "time")).toBe("not known");
    const known = turn({ ...review, round: 1, workMs: 10 * MIN });
    const mixed = usageView(logWith([{ turn: known }, { turn: lost }]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(mixed.time).toEqual({ value: 10 * MIN, atLeast: true });
    expect(figureText(mixed.time, "time")).toBe("at least 10m");
  });

  it("includes Security reviewers' stages and time alongside their verdicts", () => {
    const security = turn({ taskId: "g", roleId: "security-reviewer", profileId: "opus-high", stageId: "g:security", stageKind: "review-chain", workMs: 10 * MIN });
    const verdict: WorkMoment = { id: "security-verdict", taskId: "g", productId: "shop", at: NOW - HOUR, stageId: "g:security", kind: "verdict", roleId: "security-reviewer", profileId: "opus-high", verdict: "fail", count: 1, blocking: 1 };
    const row = usageView(logWith([{ turn: security }], [verdict]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(row).toMatchObject({ stages: 1, time: { value: 10 * MIN, atLeast: false }, rounds: 1, blocking: 1, sentBack: 1 });
  });

  it("keeps a reviewer's fail verdict even when no new blocking finding was raised", () => {
    const reviewer = turn({ taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review" });
    const verdict: WorkMoment = { id: "verdict-only", taskId: "g", productId: "shop", at: NOW - HOUR, stageId: "g:review", kind: "verdict", roleId: "code-reviewer", profileId: "opus-high", verdict: "fail", count: 0, blocking: 0 };
    const row = usageView(logWith([{ turn: reviewer }], [verdict]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(row).toMatchObject({ rounds: 1, blocking: 0, sentBack: 1 });
  });

  it("counts what the “About these numbers” note mentions", () => {
    expect(view.about).toMatchObject({ turns: 7, codexHelperTurns: 1, claudeMainOnly: 1 });
  });
});

describe("The squad", () => {
  it("counts fix rounds for a custom build-result role", () => {
    const current = state([task("custom", "shop")]);
    current.roles = [...current.roles, { ...current.roles.find(role => role.result === "build")!, id: "repair-specialist", name: "Repair specialist" }];
    const moment: WorkMoment = { id: "custom-fix", taskId: "custom", productId: "shop", at: NOW - HOUR, kind: "stage-end", stageKind: "do", roleId: "repair-specialist", round: 2, outcome: "done", durationMs: MIN, workMs: MIN };
    const squad = usageView(logWith([], [moment]), { view: "analytics", period: "today" }, { now: NOW, state: current }).squad;
    expect(squad.stageKinds).toEqual([expect.objectContaining({ key: "fixes", label: "Fixes after review", runs: 1 })]);
  });

  it("orders custom read-only and editable notes roles in workflow stage order around Build", () => {
    const current = state([task("notes-order", "shop")]);
    const baseNotes = current.roles.find((role) => role.result === "notes")!;
    current.roles = [
      ...current.roles,
      {
        ...baseNotes,
        id: "added-domain-analyst",
        name: "Domain analyst",
        added: true,
        canEdit: false,
        analyticsLabel: undefined,
        analyticsOrder: undefined,
      },
      {
        ...baseNotes,
        id: "added-copywriter",
        name: "Copywriter",
        added: true,
        canEdit: true,
        column: "building",
        analyticsLabel: undefined,
        analyticsOrder: undefined,
      },
    ];
    const at = NOW - HOUR;
    const base = { taskId: "notes-order", productId: "shop", at, kind: "stage-end" as const, outcome: "done" as const, durationMs: MIN, workMs: MIN };
    const moments: WorkMoment[] = [
      { ...base, id: "m-ship", stageKind: "do", roleId: "release-manager" },
      { ...base, id: "m-review", stageKind: "review-chain", roleId: "code-reviewer" },
      { ...base, id: "m-copy", stageKind: "do", roleId: "added-copywriter", round: 1 },
      { ...base, id: "m-build", stageKind: "do", roleId: "builder", round: 1 },
      { ...base, id: "m-analyst", stageKind: "do", roleId: "added-domain-analyst", round: 1 },
    ];
    const squad = usageView(logWith([], moments), { view: "analytics", period: "today" }, { now: NOW, state: current }).squad;
    expect(squad.stageKinds.map((entry) => entry.label)).toEqual([
      "Domain analyst",
      "Build",
      "Copywriter",
      "Review",
      "Delivery",
    ]);
  });

  it("counts stages, deliveries, send-backs, design rounds, questions and failures", () => {
    const at = NOW - 2 * HOUR;
    const base = { taskId: "k", productId: "shop" };
    const moments: WorkMoment[] = [
      { ...base, id: "1", at, kind: "stage-end", stageKind: "do", roleId: "builder", round: 1, outcome: "done", durationMs: 40 * MIN, workMs: 30 * MIN },
      { ...base, id: "2", at, kind: "stage-end", stageKind: "do", roleId: "builder", round: 1, outcome: "done", durationMs: 20 * MIN, workMs: 20 * MIN },
      { ...base, id: "3", at, kind: "stage-end", stageKind: "review-chain", roleId: "code-reviewer", outcome: "sent-back", durationMs: 10 * MIN, workMs: 10 * MIN },
      { ...base, id: "4", at, kind: "review-end", outcome: "sent-back" },
      { ...base, id: "5", at, kind: "review-end", outcome: "passed" },
      { ...base, id: "6", at, kind: "design-end", outcome: "settled", rounds: 2 },
      { ...base, id: "7", at, kind: "design-end", outcome: "to-you", rounds: 3 },
      { ...base, id: "8", at, kind: "ask", ask: "question", answer: "answered", durationMs: 4 * MIN },
      { ...base, id: "9", at, kind: "ask", ask: "permission", answer: "allowed", durationMs: 2 * MIN },
      { ...base, id: "10", at, kind: "ask", ask: "checkpoint", answer: "approved", durationMs: 30 * MIN },
      { ...base, id: "11", at, kind: "failure", outcome: "limit" },
      { ...base, id: "12", at, kind: "retry" },
      { ...base, id: "13", at, kind: "redo" },
      { ...base, id: "14", at, kind: "task-end", outcome: "delivered" },
      { ...base, id: "15", at, kind: "task-end", outcome: "cancelled" },
    ];
    const log = logWith([{ turn: turn({ taskId: "k", roleId: "builder", profileId: "sol-high", end: "interrupted" }) }], moments);
    const squad = usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: state([task("k", "shop")]) }).squad;
    expect(squad).toMatchObject({ stagesRun: 3, turnsRun: 1, delivered: 1, cancelled: 1 });
    // Deliveries are charted per day, Today included: one column for today, not one per hour.
    expect(squad.chart).toEqual([{ start: periodRange("today", NOW).from, label: "Today", delivered: 1, cancelled: 1 }]);
    const week = usageView(log, { view: "analytics", period: "7d" }, { now: NOW, state: state([task("k", "shop")]) }).squad;
    expect(week.chart).toHaveLength(7);
    expect(week.chart.at(-1)).toMatchObject({ delivered: 1, cancelled: 1 });
    expect(squad.stageKinds.find((kind) => kind.label === "Build")).toMatchObject({ runs: 2, typicalMs: 30 * MIN, agentShare: 50 / 60 });
    expect(squad.sendBacks).toBe("1 of 2 reviews sent work back to the builder.");
    expect(squad.designRounds).toBe("Designs took 2.5 rounds on average; 1 of 2 came to you to decide.");
    expect(squad.asks).toBe("Agents stopped to ask you 2 times; you answered in 3m on average. 1 checkpoint waited 30m on average for your OK.");
    expect(squad.failures).toBe("1 failure (1 usage limit reached) and 1 retry.");
    expect(squad.details).toMatchObject({ retries: 1, redone: 1, interrupted: 1 });
  });
});

describe("Unanswered requests", () => {
  it("counts unanswered questions without treating them as zero-length answers", () => {
    const base = { taskId: "q", productId: "shop", kind: "ask" as const, at: NOW - HOUR };
    const log = logWith([], [
      { ...base, id: "question", ask: "question" },
      { ...base, id: "permission", ask: "permission", answer: "allowed", durationMs: 4 * MIN },
      { ...base, id: "checkpoint", ask: "checkpoint" },
    ]);
    const squad = usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: state([task("q", "shop")]) }).squad;
    expect(squad.asks).toContain("Agents stopped to ask you 2 times");
    expect(squad.asks).toContain("you answered in 4m on average; 1 unanswered");
    expect(squad.asks).toContain("1 checkpoint; 1 unanswered");
    expect(squad.asks).not.toContain("under a minute");
  });
});

describe("Today", () => {
  it("adds up since local midnight across products, per tool", () => {
    const yesterday = turn({ taskId: "m", roleId: "builder", profileId: "sol-high", startedAt: NOW - 20 * HOUR });
    const log = logWith([{ turn: turn({ taskId: "m", roleId: "builder", profileId: "sol-high" }) }, { turn: turn({ taskId: "n", productId: "notes", roleId: "builder", profileId: "opus-high" }) }, { turn: yesterday }]);
    const s = { ...state([task("m", "shop"), task("n", "notes")]), work: { version: 1, since: 0 } };
    const today = usageView(log, { view: "today" }, { now: NOW, state: s });
    expect(today.tokens.value).toBe(20_000);
    expect(today.byTool.find((entry) => entry.toolId === "codex")).toMatchObject({ tokens: { value: 10_000 } });
  });

  it("gives each tool's nearest limit with when it was reported, and drops it the moment it resets", () => {
    const weekly = { toolId: "codex", kind: "codex:primary", windowMinutes: 10_080, utilization: 0.16, status: "allowed" as const, resetsAt: NOW + 5 * 24 * HOUR, at: NOW - 2 * MIN };
    const fiveHour = { ...weekly, kind: "codex:secondary", windowMinutes: 300, utilization: 0.91, status: "allowed_warning" as const, resetsAt: NOW + HOUR };
    const limits = [weekly, fiveHour];
    expect(nearestLimitWords(limits, "codex", NOW)).toMatchObject({ label: "5-hour", used: "91% used · close to the limit", reported: "reported 2m ago" });
    expect(nextReset(limits, NOW)).toBe(NOW + HOUR);
    // Once the 5-hour limit resets, its old percentage is gone and the weekly one is the nearest.
    expect(nearestLimitWords(limits, "codex", NOW + HOUR)).toMatchObject({ label: "weekly", used: "16% used", reported: "reported 1h ago" });
    expect(nextReset(limits, NOW + HOUR)).toBe(NOW + 5 * 24 * HOUR);
    expect(nearestLimitWords(limits, "claude-code", NOW)).toBeUndefined();
    expect(nearestLimitWords(limits, "codex", NOW + 6 * 24 * HOUR)).toBeUndefined();
  });

  it("counts periods from local midnight", () => {
    const today = periodRange("today", NOW);
    expect(new Date(today.from).getHours()).toBe(0);
    expect(today.buckets).toHaveLength(24);
    const month = periodRange("30d", NOW);
    expect(month.buckets).toHaveLength(30);
    expect(new Date(month.from).getDate()).toBe(new Date(NOW - 29 * 24 * HOUR).getDate());
  });
});
