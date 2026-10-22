import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { createDemoState, MemoryWorkLog, taskUsageSummaries, usageView, type HistoryQuery, type Task, type WorkTurn } from "@petrina/core";
import { StateProjection } from "../src/state-projection.js";
import { Store } from "../src/store.js";
import { WorkLog } from "../src/worklog.js";
import { removeDir, tempDir } from "./fixtures.js";

const base = createDemoState(1_800_000_000_000);
const turn: WorkTurn = { id: "turn", taskId: "task-54", productId: "shop", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "codex", profileId: "sol-high", sessionId: "continued-session", startedAt: base.now - 600_000, endedAt: base.now - 60_000, end: "finished", reason: "first", mainOnly: false, helpers: 0, workMs: 60_000, tokens: { total: 1000 } };

function fixture() {
  const folder = tempDir("petrina-history-usage-");
  const store = new Store(join(folder, "state.db"));
  const log = new WorkLog(store.database);
  const memory = new MemoryWorkLog(0);
  const tasks: Task[] = Array.from({ length: 55 }, (_, i) => ({ ...base.tasks[0]!, id: `task-${i}`, title: `Finished work ${i}`, state: i < 5 ? "cancelled" : "done", finishedAt: base.now + i, productId: i % 2 ? "shop" : "billing", repositories: i === 54 ? ["shop", "billing"].map(productId => ({ productId, completedStages: [], delivery: "local" })) : undefined }));
  const state = { ...base, tasks };
  store.save(state);
  const host = { stopped: false, s: { tasks: [] }, store, tracking: { log } } as unknown as ConstructorParameters<typeof StateProjection>[0];
  const projection = new StateProjection(host, () => { throw new Error("History must not normalize task bodies"); });
  store.history.get = () => { throw new Error("History must not load task bodies"); };
  const record = (extra: Partial<WorkTurn>) => {
    const entry = { ...turn, ...extra };
    log.startTurn(entry);
    if (entry.end) log.endTurn(entry.id, { ...entry, end: entry.end, endedAt: entry.endedAt ?? entry.startedAt }, []);
    memory.addTurn(entry);
    return entry;
  };
  return { state, store, log, memory, projection, record, close: () => { log.close(); store.close(); removeDir(folder); } };
}

it("matches task details across design, review, fix and retry rounds without double-counting reports", () => {
  const f = fixture();
  try {
    for (const [i, stage] of ["plan", "design", "design", "build", "review", "build", "build", "review"].entries()) {
      const entry = f.record({ id: `round-${i}`, productId: i % 2 ? "shop" : "billing", stageId: stage, round: i + 1, fixing: i === 5, end: i === 5 ? "agent-stopped" : "finished", agentRunId: `start-${i}`, mainOnly: true, helpers: 2 });
      // Repeated/final reports replace this turn's earlier numbers.
      f.log.endTurn(entry.id, { ...entry, end: entry.end!, endedAt: entry.endedAt!, tokens: { total: 2000 } }, [{ model: "sol", total: 2000 }]);
      f.memory.endTurn(entry.id, { tokens: { total: 2000 } });
    }
    f.record({ id: "still-running", end: undefined, endedAt: undefined, tokens: { total: 999_999 } });
    const detail = usageView(f.log, { view: "task", taskId: "task-54" }, { state: f.state, now: base.now });
    const expected = { tokens: { atLeast: false, value: 16_000 }, time: { atLeast: false, value: 480_000 } };
    expect({ tokens: detail.tokens, time: detail.time }).toEqual(expected);
    expect(taskUsageSummaries(f.memory, ["task-54"]).get("task-54")).toEqual(expected);
    for (const productId of [undefined, "shop", "billing"]) expect(f.projection.historyPage({ productId, includeUsage: true }).items.find(item => item.id === "task-54")!.usage).toEqual(expected);
    expect(usageView(f.log, { view: "task", taskId: "task-54" }, { state: f.state, now: base.now + 86_400_000 }).time).toEqual(detail.time);
    expect(f.projection.historyPage({ includeUsage: true }).items[0]!.usage).toEqual(expected);
  } finally { f.close(); }
});

it("shares partial, missing, lost and before-tracking rules with details and the demo", () => {
  const f = fixture();
  try {
    f.record({ taskId: "task-54", id: "partial-known" });
    f.record({ taskId: "task-54", id: "partial-silent", tokens: undefined });
    f.record({ taskId: "task-53", id: "lost-known" });
    f.record({ taskId: "task-53", id: "lost", end: "lost", workMs: undefined, tokens: undefined });
    f.record({ taskId: "task-52", id: "only-lost", end: "lost", workMs: undefined, tokens: undefined });
    f.record({ taskId: "task-51", id: "silent", tokens: undefined });
    f.record({ taskId: "task-49", id: "straddled" });
    for (const taskId of ["task-50", "task-49"]) { f.log.markUntracked(taskId, "shop", 0); f.memory.markUntracked(taskId, "shop"); }
    const items = f.projection.historyPage({ includeUsage: true, limit: 100 }).items;
    const summaries = taskUsageSummaries(f.memory, items.map(item => item.id));
    for (const item of items) {
      const detail = usageView(f.log, { view: "task", taskId: item.id }, { state: f.state, now: base.now });
      if (detail.empty === "nothing") {
        expect(detail.tokens).toEqual({ atLeast: false, value: 0 });
        expect(detail.time).toEqual({ atLeast: false, value: 0 });
        expect(item.usage).toEqual({ empty: "nothing", tokens: { atLeast: false }, time: { atLeast: false } });
      } else expect(item.usage).toEqual({ tokens: detail.tokens, time: detail.time, ...(detail.empty ? { empty: detail.empty } : {}) });
      expect(item.usage).toEqual(summaries.get(item.id));
    }
    const usage = (id: number) => items.find(item => item.id === `task-${id}`)!.usage!;
    expect(usage(54)).toEqual({ tokens: { atLeast: true, value: 1000 }, time: { atLeast: false, value: 120_000 } });
    expect(usage(53)).toEqual({ tokens: { atLeast: true, value: 1000 }, time: { atLeast: true, value: 60_000 } });
    expect(usage(52)).toEqual({ tokens: { atLeast: true, unknown: true }, time: { atLeast: true, unknown: true } });
    expect(usage(51)).toEqual({ tokens: { atLeast: true }, time: { atLeast: false, value: 60_000 } });
    expect(usage(50).empty).toBe("untracked");
    expect(usage(49)).toEqual({ tokens: { atLeast: true, value: 1000 }, time: { atLeast: true, value: 60_000 } });
    expect(usage(0).empty).toBe("nothing");
    expect(usage(0).tokens.value).toBeUndefined();
    expect(usage(0).time.value).toBeUndefined();
  } finally { f.close(); }
});

it("keeps paging and filters unchanged, reads one bounded set of summaries, and picks up late usage", () => {
  const f = fixture();
  const query = spyOn(f.store.database, "query");
  const batch = spyOn(f.log, "taskTallies");
  try {
    for (let i = 0; i < 55; i++) f.record({ taskId: `task-${i}`, id: `use-${i}`, tokens: { total: i + 1 } });
    f.log.turns = () => { throw new Error("History must not read individual turns"); };
    f.log.lines = () => { throw new Error("History must not read model lines"); };
    f.log.untracked = () => { throw new Error("History must not read all earlier tasks"); };
    const check = (request: HistoryQuery) => {
      const plain = f.projection.historyPage(request);
      expect(batch).not.toHaveBeenCalled();
      query.mockClear();
      const page = f.projection.historyPage({ ...request, includeUsage: true });
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0]![0]).toEqual(page.items.map(item => item.id));
      const workReads = query.mock.calls.map(([sql]) => String(sql)).filter(sql => /work_turns|work_moments/.test(sql));
      expect(workReads).toHaveLength(page.items.length ? 1 : 0);
      if (page.items.length) expect(workReads[0]).toContain("task_id IN (SELECT task_id FROM requested)");
      expect(page.items.map(({ usage: _usage, ...item }) => item)).toEqual([...plain.items]);
      expect(page.total).toBe(plain.total);
      expect(page.nextCursor).toBe(plain.nextCursor);
      for (const item of page.items) expect(item.usage!.tokens.value).toBe(Number(item.id.slice(5)) + 1);
      batch.mockClear();
      return page;
    };
    const first = check({});
    expect(first.items).toHaveLength(24);
    expect(first.total).toBe(55);
    const second = check({ cursor: first.nextCursor });
    expect(second.items).toHaveLength(24);
    expect(check({ cursor: second.nextCursor }).items).toHaveLength(7);
    check({ productId: "shop" });
    check({ productId: "billing", query: "Finished work 5", status: "marked-done" });
    check({ status: "cancelled" });
    expect(check({ query: "No matching title" }).items).toEqual([]);
    f.record({ taskId: "task-54", id: "late-last-turn", tokens: { total: 500 } });
    expect(f.projection.historyPage({ includeUsage: true }).items[0]!.usage!.tokens.value).toBe(555);
    expect(f.projection.historyPage({}).items[0]).not.toHaveProperty("usage");
  } finally { query.mockRestore(); batch.mockRestore(); f.close(); }
});
