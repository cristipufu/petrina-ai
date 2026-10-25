import { runCommand } from "@petrina/test-support/commands";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { UsageReport } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Coordination, type Result } from "../../../src/coordination.js";
import { ANALYTICS_HOLD_MS, ANALYTICS_HOLDS, analyticsHolds } from "../../../src/analytics-read.js";
import { EngineClient } from "../../client.js";
import { writeConnection } from "../../../src/instance.js";
import { mcpRequest } from "../../../src/mcp.js";
import { serve } from "../../../src/server.js";
import { CLI, removeDir, tempDir } from "../../fixtures.js";
import { engineEnv } from "../../support.js";

const DAY = 86_400_000;
const roots: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.shutdown()));
  roots.splice(0).forEach(removeDir);
});

/** A minute before local midnight: continuing a read crosses into the next day. */
const START = new Date(2026, 9, 21, 23, 59, 0).getTime();

function fixture(live: UsageReport[] = currentReadings(START)) {
  const home = tempDir("analytics-read-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, terminals: () => [] });
  engines.push(e);
  e.setPoolPaused(true);
  e.schedule = () => {};
  e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const taskId = e.addTask({ productId: "product", title: "First task" });
  const log = e.tracking.log;
  for (let day = 0; day < 30; day++)
    for (const [index, toolId] of ["claude-code", "codex"].entries()) {
      const id = `turn-${day}-${toolId}`;
      const startedAt = START - day * DAY - 3_600_000 - index * 60_000;
      log.startTurn({ id, taskId, productId: "product", stageId: `stage-${day % 3}`, stageTitle: `Stage ${day % 3}`, stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId, profileId: `${toolId}-high`, sessionId: `session-${id}`, reason: "first", startedAt, mainOnly: false, helpers: 0 });
      log.endTurn(id, { end: "finished", endedAt: startedAt + 30_000, workMs: 30_000, mainOnly: false, helpers: 0, tokens: { input: 1000 + day, output: 200, total: 1200 + day } }, [{ model: `model-${index}`, input: 1000 + day, output: 200, total: 1200 + day }]);
    }
  for (let day = 6; day >= 1; day--) for (const report of currentReadings(START)) e.tracking.usageReported({ ...report, utilization: day / 10, at: START - day * DAY });
  for (const report of live) e.tracking.usageReported(report);
  e.s.pool.usage = structuredClone(live);
  // Every surface reaches the engine through its own coordination instance.
  return { e, taskId, home, c: () => new Coordination(e) };
}

function currentReadings(at: number): UsageReport[] {
  return [
    { toolId: "codex", kind: "five_hour", utilization: 0.4, status: "allowed", resetsAt: at + 3_600_000, windowMinutes: 300, at: at - 60_000 },
    { toolId: "codex", kind: "seven_day", utilization: 0.2, status: "allowed", resetsAt: at + 3 * DAY, windowMinutes: 10_080, at: at - 60_000 },
    { toolId: "claude-code", kind: "five_hour", utilization: 0.3, status: "allowed", resetsAt: at + 7_200_000, at: at - 60_000 },
  ];
}

/** Pages read while time passes: `between` runs before each continuation. */
async function readAll(call: () => Coordination, args: Record<string, unknown>, between: (page: number) => void = () => {}) {
  const pages: Result[] = [await call().call("analytics.inspect", args)];
  while (pages.at(-1)!.next) {
    between(pages.length);
    pages.push(await call().call("analytics.inspect", { ...args, cursor: pages.at(-1)!.next }));
  }
  return pages;
}

function expectWhole(pages: Result[], original: string, asOf: number) {
  let offset = 0;
  for (const page of pages) {
    expect(page).toEqual(expect.objectContaining({ outcome: "completed", offset, total: original.length, asOf }));
    offset += String(page.text).length;
  }
  expect(pages.at(-1)!.shortened).toBe(false);
  expect(pages.map((page) => page.text).join("")).toBe(original);
}

const frozen = (start: number) => {
  const clock = { now: start };
  const spy = spyOn(Date, "now").mockImplementation(() => clock.now);
  return { clock, restore: () => spy.mockRestore() };
};

const noReport = (result: Result) => {
  expect(result.text).toBeUndefined();
  expect(result.next).toBeUndefined();
};

describe("paged analytics reads", () => {
  it("preserves exact zero figures when the coordinator reads a task that has never run", async () => {
    const { e, c } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Not started" });
    const result = await c().call("analytics.inspect", { taskId, limit: 32000 });
    expect(result.outcome).toBe("completed");
    expect(JSON.parse(String(result.text))).toMatchObject({
      view: "task", empty: "nothing", tokens: { atLeast: false, value: 0 }, time: { atLeast: false, value: 0 },
    });
  });

  it.each(["today", "7d", "30d"] as const)("keeps a %s product read whole while the clock passes midnight and accounts refresh", async (period) => {
    const { e, c } = fixture();
    const { clock, restore } = frozen(START);
    try {
      const live = structuredClone(e.s.pool.usage!);
      const original = JSON.stringify(e.tracking.usageAt({ view: "analytics", period, productId: "product" }, START, live), null, 2);
      const limit = Math.ceil(original.length / 4);
      const pages = await readAll(c, { productId: "product", period, limit }, () => {
        clock.now += 25_000;
        // A same-percentage refresh moves only the live reading's time; history does not repeat it.
        const refreshed = { ...e.s.pool.usage![0]!, at: clock.now };
        expect(e.tracking.log.recordUsage(refreshed)).toBe(false);
        e.s.pool.usage = [refreshed, ...e.s.pool.usage!.slice(1)];
      });
      expect(pages.length).toBeGreaterThanOrEqual(4);
      expect(new Date(clock.now).getDate()).not.toBe(new Date(START).getDate());
      expectWhole(pages, original, START);
      expect(pages.slice(0, -1).every((page) => page.expiresAt === START + ANALYTICS_HOLD_MS)).toBe(true);
      // A fresh read starts at the current time, with the refreshed reading.
      const fresh = await c().call("analytics.inspect", { productId: "product", period, limit: 32000 });
      expect(fresh.asOf).toBe(clock.now);
      expect(fresh.text).not.toBe(pages[0]!.text);
    } finally {
      restore();
    }
  });

  it("reads a report larger than one 32,000-character page across midnight, from separate requests", async () => {
    const { e, c } = fixture();
    const { clock, restore } = frozen(START);
    try {
      const original = JSON.stringify(e.tracking.usageAt({ view: "analytics", period: "30d" }, START, structuredClone(e.s.pool.usage!)), null, 2);
      expect(original.length).toBeGreaterThan(64_000);
      const pages = await readAll(c, { period: "30d", limit: 32000 }, () => {
        clock.now += 40_000 + 28;
      });
      expect(pages.length).toBe(Math.ceil(original.length / 32000));
      expectWhole(pages, original, START);
    } finally {
      restore();
    }
  });

  it("keeps later account changes outside the original view, for several allowances and for none", async () => {
    for (const initial of [currentReadings(START), []]) {
      const { e, c } = fixture(initial);
      const { clock, restore } = frozen(START);
      try {
        const original = JSON.stringify(e.tracking.usageAt({ view: "analytics", period: "7d" }, START, structuredClone(initial)), null, 2);
        const changes = [
          // A changed later reading of an existing allowance.
          () => {
            const report = { ...currentReadings(START)[0]!, utilization: 0.9, at: clock.now };
            e.tracking.usageReported(report);
            e.s.pool.usage = [report, ...(e.s.pool.usage ?? []).slice(1)];
          },
          // An allowance added, one replaced, and one removed.
          () => {
            const added = { toolId: "grok", kind: "credits", utilization: 0.5, status: "allowed" as const, at: clock.now };
            e.tracking.usageReported(added);
            e.s.pool.usage = [...(e.s.pool.usage ?? []), added];
          },
          () => {
            const replaced = { ...currentReadings(START)[2]!, status: "rejected" as const, utilization: 1, at: clock.now };
            e.tracking.usageReported(replaced);
            e.s.pool.usage = [...(e.s.pool.usage ?? []).filter((report) => report.toolId !== "claude-code"), replaced];
          },
          () => {
            e.s.pool.usage = (e.s.pool.usage ?? []).filter((report) => report.kind !== "seven_day");
          },
        ];
        const pages = await readAll(c, { period: "7d", limit: Math.ceil(original.length / 5) }, (page) => {
          clock.now += 10_000;
          changes[(page - 1) % changes.length]!();
        });
        expectWhole(pages, original, START);
        // The current allowances show on a fresh read.
        const fresh = JSON.parse((await readAll(c, { period: "7d", limit: 32000 })).map((page) => page.text).join(""));
        const current = fresh.limits.tools.flatMap((tool: { limits: { key: string; current: boolean }[] }) => tool.limits.filter((limit) => limit.current).map((limit) => limit.key)).sort();
        expect(current).toEqual(["claude-code|five_hour|", "codex|five_hour|", "grok|credits|"]);
        expect(JSON.parse(original).limits.tools.some((tool: { limits: { current: boolean }[] }) => tool.limits.some((limit) => limit.current))).toBe(initial.length > 0);
      } finally {
        restore();
      }
    }
  });

  it("reports recorded usage, saved readings and task detail changes before returning more text", async () => {
    const { e, c, taskId } = fixture();
    const { clock, restore } = frozen(START);
    try {
      const changes: [string, () => void][] = [
        ["recorded tokens", () => {
          e.tracking.log.startTurn({ id: "late", taskId, productId: "product", stageId: "stage-0", stageTitle: "Stage 0", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "codex", profileId: "codex-high", sessionId: "late", reason: "first", startedAt: START - 5_000, mainOnly: false, helpers: 0 });
          e.tracking.log.endTurn("late", { end: "finished", endedAt: clock.now, workMs: 5_000, mainOnly: false, helpers: 0, tokens: { total: 10 } }, [{ model: "model-1", total: 10 }]);
        }],
        ["a saved reading inside the view", () => {
          e.tracking.usageReported({ ...currentReadings(START)[1]!, utilization: 0.25, at: START - 30_000 });
        }],
        ["task details", () => {
          e.task(taskId)!.title = "Renamed task";
        }],
      ];
      for (const [, change] of changes) {
        const first = await c().call("analytics.inspect", { period: "7d", limit: 2000 });
        expect(first.asOf).toBe(clock.now);
        clock.now += 1_000;
        expect((await c().call("analytics.inspect", { period: "7d", limit: 2000, cursor: first.next })).outcome).toBe("completed");
        change();
        const changed = await c().call("analytics.inspect", { period: "7d", limit: 2000, cursor: first.next });
        expect(changed).toEqual({ outcome: "changed", message: expect.stringContaining("changed after its first page"), asOf: first.asOf });
      }
      // Task usage changes too when its own recorded tokens do.
      const task = await c().call("analytics.inspect", { taskId, limit: 500 });
      e.tracking.log.endTurn("late", { end: "finished", endedAt: clock.now, workMs: 6_000, mainOnly: false, helpers: 0, tokens: { total: 20 } }, [{ model: "model-1", total: 20 }]);
      const changed = await c().call("analytics.inspect", { taskId, limit: 500, cursor: task.next });
      expect(changed.outcome).toBe("changed");
      expect(changed.asOf).toBe(task.asOf);
      noReport(changed);
    } finally {
      restore();
    }
  });

  it("returns task usage with its as-of time on every page, without a hold", async () => {
    const { e, c, taskId } = fixture();
    const { clock, restore } = frozen(START);
    try {
      const before = analyticsHolds(e).size;
      const original = JSON.stringify(e.tracking.usageAt({ view: "task", taskId }, START), null, 2);
      const pages = await readAll(c, { taskId, limit: Math.ceil(original.length / 3) }, () => {
        clock.now += ANALYTICS_HOLD_MS;
      });
      expect(pages.length).toBe(3);
      expectWhole(pages, original, START);
      expect(pages.every((page) => page.expiresAt === undefined)).toBe(true);
      expect(analyticsHolds(e).size).toBe(before);
      const single = await c().call("analytics.inspect", { taskId, limit: 32000 });
      expect(single).toEqual(expect.objectContaining({ outcome: "completed", offset: 0, shortened: false, asOf: clock.now }));
      expect(single.next).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("explains expired, evicted and restarted reads without substituting current data", async () => {
    const { e, c, home } = fixture();
    const { clock, restore } = frozen(START);
    try {
      const first = await c().call("analytics.inspect", { period: "7d", limit: 1000 });
      clock.now = START + ANALYTICS_HOLD_MS - 1;
      const second = await c().call("analytics.inspect", { period: "7d", limit: 1000, cursor: first.next });
      expect(second.outcome).toBe("completed");
      // Continuing did not extend the hold.
      clock.now = START + ANALYTICS_HOLD_MS;
      const expired = await c().call("analytics.inspect", { period: "7d", limit: 1000, cursor: second.next });
      expect(expired).toEqual({ outcome: "unavailable", reason: "expired", message: expect.stringContaining("expired ten minutes after its first page"), asOf: START });

      const oldest = await c().call("analytics.inspect", { period: "today", limit: 1 });
      for (let index = 0; index < ANALYTICS_HOLDS.entries; index++) await c().call("analytics.inspect", { period: "today", limit: 1 });
      expect(analyticsHolds(e).size).toBe(ANALYTICS_HOLDS.entries);
      const evicted = await c().call("analytics.inspect", { period: "today", limit: 1, cursor: oldest.next });
      expect(evicted).toEqual({ outcome: "unavailable", reason: "evicted", message: expect.stringContaining("released early"), asOf: oldest.asOf });

      const held = await c().call("analytics.inspect", { productId: "product", period: "30d", limit: 1000 });
      restore();
      await e.shutdown();
      const restarted = new Engine(home, { agentCommand: () => undefined, terminals: () => [] });
      engines.push(restarted);
      restarted.setPoolPaused(true);
      restarted.schedule = () => {};
      const after = await new Coordination(restarted).call("analytics.inspect", { productId: "product", period: "30d", limit: 1000, cursor: held.next });
      expect(after).toEqual({ outcome: "unavailable", reason: "engine-restarted", message: expect.stringContaining("restarted"), asOf: held.asOf });
    } finally {
      restore();
    }
  });

  it("returns no report text for malformed, unsupported, mismatched or out-of-range references", async () => {
    const { e, c, taskId } = fixture();
    const { clock, restore } = frozen(START);
    try {
      const first = await c().call("analytics.inspect", { period: "7d", limit: 1000 });
      const saved = JSON.parse(Buffer.from(String(first.next), "base64url").toString());
      const forge = (changes: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...saved, ...changes })).toString("base64url");
      clock.now += 1_000;
      const malformed = ["not a reference", Buffer.from("[]").toString("base64url"), Buffer.from(JSON.stringify({ key: saved.key, at: 1000 })).toString("base64url"), forge({ v: 2 }), forge({ asOf: -1 }), forge({ asOf: 1.5 }), forge({ asOf: clock.now + 1 }), forge({ at: 0 }), forge({ at: "1000" }), forge({ hold: "../x" }), forge({ run: undefined }), forge({ extra: true }), forge({ asOf: START - 1 })];
      for (const cursor of malformed) {
        const result = await c().call("analytics.inspect", { period: "7d", limit: 1000, cursor });
        expect(result.outcome).toBe("invalid");
        expect(result.asOf).toBeUndefined();
        noReport(result);
      }
      for (const [args, cursor] of [
        [{ period: "30d" }, first.next],
        [{ period: "7d", productId: "product" }, first.next],
        [{ taskId }, first.next],
        [{ period: "7d" }, forge({ at: Number(first.total) })],
      ] as const) {
        const result = await c().call("analytics.inspect", { ...args, limit: 1000, cursor });
        expect(result.outcome).toBe("invalid");
        expect(result.asOf).toBe(START);
        noReport(result);
      }
      const task = await c().call("analytics.inspect", { taskId, limit: 100 });
      const taskSaved = JSON.parse(Buffer.from(String(task.next), "base64url").toString());
      const beyond = await c().call("analytics.inspect", { taskId, limit: 100, cursor: Buffer.from(JSON.stringify({ ...taskSaved, at: Number(task.total) })).toString("base64url") });
      expect(beyond).toEqual({ outcome: "invalid", message: expect.any(String), asOf: task.asOf });
      expect((await c().call("analytics.inspect", { period: "7d", limit: 100, cursor: task.next })).outcome).toBe("invalid");
      // The read is still identifiable when its product is gone.
      const product = await c().call("analytics.inspect", { productId: "product", period: "7d", limit: 1000 });
      e.s.products = e.s.products.filter((entry) => entry.id !== "product");
      expect(await c().call("analytics.inspect", { productId: "product", period: "7d", limit: 1000, cursor: product.next })).toEqual({ outcome: "missing", message: "That product does not exist.", asOf: product.asOf });
      // Every product's report names it as removed now.
      expect((await c().call("analytics.inspect", { period: "7d", limit: 1000, cursor: first.next })).outcome).toBe("changed");
    } finally {
      restore();
    }
  });

  it("reports oversized live readings unavailable rather than shortening them", async () => {
    const many = Array.from({ length: 400 }, (_, index): UsageReport => ({ toolId: "antigravity", kind: "five_hour", model: `model-${index}`, name: `A long allowance name ${"x".repeat(200)} ${index}`, utilization: 0.1, status: "allowed", at: START - 60_000 }));
    const { e, c } = fixture(many);
    const { restore } = frozen(START);
    try {
      const before = analyticsHolds(e).retainedBytes;
      const result = await c().call("analytics.inspect", { period: "7d", limit: 32000 });
      expect(result).toEqual({ outcome: "unavailable", reason: "too-large", message: expect.stringContaining("Nothing was shortened"), asOf: START, total: expect.any(Number) });
      expect(analyticsHolds(e).retainedBytes).toBe(before);
    } finally {
      restore();
    }
  });
});

describe("analytics reads from the terminal and connected agents", () => {
  it("continues one read across separate terminal invocations and agent requests to the same engine", async () => {
    const { e, home } = fixture();
    const token = "analytics-key-012345678901234567890";
    const server = serve(e, { port: 0, token });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, token, pid: process.pid });
    const client = new EngineClient(home, () => {
      throw new Error("Unexpected launch");
    });
    const cli = async (...args: string[]) => {
      const result = await runCommand([process.execPath, CLI, "analytics", "inspect", "--period", "7d", "--limit", "3000", ...args, "--json"], { env: engineEnv(home), timeoutMs: 30_000 });
      return { result: JSON.parse(result.stdout) as Result, code: result.code };
    };
    const agent = async (cursor: unknown) => {
      const reply = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_analytics_inspect", arguments: { period: "7d", limit: 3000, cursor } } }, client);
      return (reply!.result as { structuredContent: Result }).structuredContent;
    };
    try {
      // The real clock moves between these requests, as it did when the next page failed.
      const first = await cli();
      expect(first.code).toBe(0);
      const second = await agent(first.result.next);
      expect(second).toEqual(expect.objectContaining({ outcome: "completed", offset: 3000, total: first.result.total, asOf: first.result.asOf }));
      const third = await cli("--cursor", String(second.next));
      expect(third.code).toBe(0);
      expect(third.result).toEqual(expect.objectContaining({ outcome: "completed", offset: 6000, total: first.result.total, asOf: first.result.asOf }));
      const refused = await cli("--cursor", "not-a-reference");
      expect([refused.code, refused.result.outcome, refused.result.text]).toEqual([2, "invalid", undefined]);
    } finally {
      server.stop(true);
    }
  });
});
