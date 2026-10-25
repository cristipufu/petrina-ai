import { NOW } from "../../fixtures/analytics.js";
import { describe, expect, it } from "vitest";

import { createDemo, createPortfolioDemo } from "../../../src/demo.js";

import { Simulator } from "../../../src/sim.js";

describe("Demos", () => {
  for (const [name, make] of [
    ["demo", createDemo],
    ["portfolio", createPortfolioDemo],
  ] as const) {
    it(`keeps high measured usage separate from provider warnings in the ${name} history`, () => {
      const demo = make(NOW);
      const history = demo.log.usageHistory({});
      const high = history.filter(reading => reading.utilization! >= 0.8);
      expect(high.length).toBeGreaterThan(0);
      expect(high.some(reading => reading.utilization! >= 0.9)).toBe(true);
      expect(new Set(high.map(reading => reading.status))).toEqual(new Set(["allowed"]));
      const codex = demo.state.pool.usage!.find(reading => reading.toolId === "codex")!;
      expect(codex).toMatchObject({ utilization: 0.84, status: "allowed" });
      expect(history.some(reading => reading.toolId === codex.toolId && reading.resetsAt === codex.resetsAt && reading.utilization! >= 0.8)).toBe(true);
    });

    it(`completes each existing request once in the ${name}`, () => {
      const demo = make(NOW);
      const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
      const requestKinds = ["question", "permission", "plan", "design", "delivery", "disagreement"];
      const pending = demo.state.inbox.filter((item) => requestKinds.includes(item.kind));
      expect(pending.length).toBeGreaterThan(0);
      for (const item of pending) {
        const requests = () => demo.log.moments({ taskId: item.taskId, kinds: ["ask"] });
        const before = requests();
        const original = before.find((moment) => moment.at === item.at && moment.answer === undefined)!;
        expect(original).toBeDefined();
        const respond = () => {
          if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") sim.allow(item.id);
          else sim.approve(item.id);
        };
        respond();
        // Settling a disagreement can immediately raise a separate design checkpoint.
        const newRequests = sim.getState().inbox.filter((next) => next.taskId === item.taskId && requestKinds.includes(next.kind) && !pending.some((previous) => previous.id === next.id));
        expect(requests()).toHaveLength(before.length + newRequests.length);
        const completed = requests().find((moment) => moment.id === original.id)!;
        expect(completed.answer).toBe(item.kind === "question" ? "answered" : item.kind === "permission" ? "allowed" : "approved");
        expect(completed.at).toBe(original.at);
        expect(completed.durationMs).toBe(NOW - item.at);
        expect(requests().filter((moment) => moment.answer === undefined)).toHaveLength(before.filter((moment) => moment.answer === undefined).length - 1 + newRequests.length);
        const after = requests();
        respond();
        expect(requests()).toEqual(after);
      }
    });

    it(`gives the ${name} thirty believable days with every case the app explains`, () => {
      const demo = make(NOW);
      const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
      const month = sim.usage({ view: "analytics", period: "30d" });
      expect(month.byTool.map((entry) => entry.toolId).sort()).toEqual(["claude-code", "codex"]);
      expect(month.chart.buckets.filter((bucket) => Object.keys(bucket.tokens).length > 0).length).toBeGreaterThan(20);
      expect(month.headline.tokens.atLeast).toBe(true);
      expect(month.byProduct?.some((entry) => entry.note === "removed")).toBe(true);
      expect(month.about.codexHelperTurns).toBeGreaterThan(0);
      expect(month.squad.details.settingsLine).not.toMatch(/^0 agent stages/);
      expect(demo.log.lines({}).some((entry, _index, all) => all.some((other) => other.turnId === entry.turnId && other.model !== entry.model))).toBe(true);
      expect(demo.state.tasks.some((entry) => sim.usage({ view: "task", taskId: entry.id }).atLeast !== "")).toBe(true);
      expect(sim.usage({ view: "today" }).tokens.value).toBeGreaterThan(0);
      expect(sim.usage({ view: "products" }).products.every((entry) => entry.turns > 0 || !demo.state.tasks.some((t) => t.productId === entry.productId && t.state !== "queued"))).toBe(true);
      expect(demo.state.pool.usage?.length).toBeGreaterThan(0);
    });
  }

  it("keeps unanswered requests in the simulated squad when their task is cancelled", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const question = demo.state.inbox.find((item) => item.kind === "question")!;
    const requests = () => demo.log.moments({ taskId: question.taskId, kinds: ["ask"] }).filter((moment) => moment.ask === "question" && moment.answer === undefined);
    expect(requests().length).toBeGreaterThan(0);
    const before = requests();
    sim.cancel(question.taskId);
    expect(requests()).toEqual(before);
    expect(sim.getState().inbox.some((item) => item.id === question.id)).toBe(false);
  });

  it("builds each demo once and gives every caller its own copy", () => {
    const first = createDemo(NOW);
    const size = first.log.size();
    const sim = new Simulator(first.state, { log: first.log, open: first.open, quirks: first.quirks, triggers: first.triggers, tickMs: 60_000 });
    for (let tick = 0; tick < 10; tick += 1) sim.tick();
    (first.state.tasks[0] as { title: string }).title = "Changed by one caller";
    expect(first.log.size()).toBeGreaterThan(size);
    const second = createDemo(NOW);
    expect(second.log.size()).toBe(size);
    expect(second.state.tasks[0]!.title).not.toBe("Changed by one caller");
    expect(second.log.products()).toEqual(first.log.products());
    expect(second.log.untracked()).toEqual(first.log.untracked());
  });

  it("keeps writing the same entries as the demo squad works", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers, tickMs: 60_000 });
    const before = sim.usage({ view: "today" }).turns;
    const version = sim.getState().work!.version;
    for (let tick = 0; tick < 30; tick += 1) sim.tick();
    expect(sim.usage({ view: "today" }).turns).toBeGreaterThan(before);
    expect(sim.getState().work!.version).toBeGreaterThan(version);
  });
});
