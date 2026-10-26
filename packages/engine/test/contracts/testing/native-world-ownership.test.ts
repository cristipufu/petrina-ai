import { completeAll } from "@petrina/core";
import { join } from "node:path";
import { rejectionOf } from "@petrina/test-support/rejections";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { ReleaseEvents } from "../../release-events.js";
import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { Engine } from "../../engine.js";
import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";

const finalizers = new Set<() => Promise<void>>();
afterEach(async () => {
  const results = await Promise.allSettled([...finalizers].map(finish => finish()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Native world controls could not confirm cleanup");
});

it("refuses a callback after the actual Engine constructor reenters fixture close", async () => {
  const fixtures = nativeWorldFixtures(), shutdown = Engine.prototype.shutdown;
  const actual = new Set<Engine>(), completed = new Set<Engine>(), shutdowns = new Set<Promise<void>>();
  let restore: (() => void) | undefined, root: string | undefined, bodies = 0;
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  let running: Promise<unknown> | undefined, finishing: Promise<void> | undefined;
  const finish = () => finishing ??= (async () => {
    const cleanup: unknown[] = [];
    try {
      await Promise.allSettled([running, fixtures.close()]);
      const settled = await Promise.allSettled([...actual].map(engine => shutdown.call(engine)));
      cleanup.push(...settled.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      const observed = await Promise.allSettled([...shutdowns]);
      cleanup.push(...observed.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      if (!cleanup.length && root) removeFixtureRoot(root);
    } finally { restore?.(); }
    if (cleanup.length) throw new AggregateError(cleanup, "Actual Engine cleanup was not confirmed; world retained");
    finalizers.delete(finish);
  })();
  finalizers.add(finish);
  try {
    const observer = spyOn(Engine.prototype, "shutdown");
    restore = () => observer.mockRestore();
    observer.mockImplementation(function (this: Engine) {
      actual.add(this);
      const work = shutdown.call(this);
      shutdowns.add(work);
      void work.then(() => { completed.add(this); }, () => undefined);
      return work;
    });
    running = fixtures.world("constructor-close", async fixture => {
      root = fixture.world.dir;
      return fixture.engine(async () => { bodies++; }, {
        agentCommand: () => undefined,
        terminals() { first = fixtures.close(); second = fixtures.close(); return []; },
      });
    });
    const result = await running.then(value => ({ value }), (error: unknown) => ({ error }));
    expect(bodies).toBe(0);
    expect("error" in result).toBe(true);
    expect(first).toBeDefined(); expect(second).toBe(first);
    await Promise.allSettled([first]);
    expect(actual.size).toBe(1);
    expect(completed).toEqual(actual);
    for (const engine of actual) {
      expect(engine.stopped).toBe(true);
      expect(() => engine.store.database.query("SELECT 1").get()).toThrow();
    }
    expect(existsSync(root!)).toBe(true);
    expect(fixtures.retained.has(root!)).toBe(true);
  } finally { await finish(); }
});

it("keeps one actual Engine by default while its generation callback is active", async () => {
  const fixtures = nativeWorldFixtures();
  const finish = () => fixtures.close();
  finalizers.add(finish);
  await setupWithCleanup(async () => {
    await fixtures.world("one-generation", async fixture => {
      await fixture.engine(async first => {
        let entered = false;
        const rejected = await rejectionOf(fixture.engine(async () => { entered = true; }, { agentCommand: () => undefined }));
        expect(rejected).toBeInstanceOf(Error);
        expect((rejected as Error).message).toContain("Stop and settle");
        expect(entered).toBe(false);
        expect(first.stopped).toBe(false);
        expect(first.store.database.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
      }, { agentCommand: () => undefined });
    });
    expect(fixtures.retained.size).toBe(0);
  }, finish);
  await finish(); finalizers.delete(finish);
});

it("owns both actual Engines when overlap is explicitly allowed while the first shutdown is held", async () => {
  const fixtures = nativeWorldFixtures(), events = new ReleaseEvents(), signal = new AbortController().signal;
  const shutdown = Engine.prototype.shutdown;
  let held: Engine | undefined, restore: (() => void) | undefined;
  const finish = async () => {
    events.release("shutdown");
    await setupWithCleanup(() => fixtures.close(), async () => { restore?.(); });
    restore?.();
  };
  finalizers.add(finish);
  await setupWithCleanup(async () => {
    const watched = spyOn(Engine.prototype, "shutdown");
    restore = () => watched.mockRestore();
    watched.mockImplementation(function (this: Engine) {
      if (this !== held) return shutdown.call(this);
      return events.wait("shutdown", signal).then(() => shutdown.call(this));
    });
    await fixtures.world("overlapping-generations", async fixture => {
      await fixture.engine(async first => {
        held = first;
        const stopping = first.shutdown();
        await completeAll([stopping, fixture.engine(async second => {
          expect(second).not.toBe(first);
          expect(first.stopped).toBe(false);
          expect(second.stopped).toBe(false);
          expect(first.store.database.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
          expect(second.store.database.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
          events.release("shutdown");
          await stopping;
          expect(first.stopped).toBe(true);
          expect(() => first.store.database.query("SELECT 1").get()).toThrow();
          expect(second.stopped).toBe(false);
        }, { agentCommand: () => undefined })]);
        expect(first.stopped).toBe(true);
      }, { agentCommand: () => undefined });
    }, { allowOverlap: true }, { stopPeers() { events.release("shutdown"); restore?.(); } });
    expect(fixtures.retained.size).toBe(0);
  }, finish);
  await finish(); finalizers.delete(finish);
});

it("refuses actual constructor reentry even when completed constructors may overlap", async () => {
  const fixtures = nativeWorldFixtures();
  const finish = () => fixtures.close();
  finalizers.add(finish);
  await setupWithCleanup(async () => {
    await fixtures.world("constructor-reentry", async fixture => {
      let attempt: Promise<unknown> | undefined, entered = 0;
      await fixture.engine(async first => {
        expect(attempt).toBeDefined();
        const rejected = await rejectionOf(attempt!);
        expect((rejected as Error).message).toContain("Stop and settle");
        expect(entered).toBe(0);
        expect(first.stopped).toBe(false);
      }, { agentCommand: () => undefined, terminals() {
        attempt = fixture.engine(async () => { entered++; }, { agentCommand: () => undefined });
        void attempt.catch(() => undefined);
        return [];
      } });
    }, { allowOverlap: true });
    expect(fixtures.retained.size).toBe(0);
  }, finish);
  await finish(); finalizers.delete(finish);
});

it("retains the world and its external browser root when browser-file disposal is not confirmed", async () => {
  const fixtures = nativeWorldFixtures();
  let root: string | undefined, browsers: string | undefined, actual: Engine | undefined;
  const finish = async () => {
    await fixtures.close();
    if (!actual) return;
    await actual.shutdown();
    if (!actual.stopped) throw new Error("The actual Engine did not stop; browser world retained");
    expect(() => actual!.store.database.query("SELECT 1").get()).toThrow();
    if (browsers) removeFixtureRoot(browsers);
    if (root) removeFixtureRoot(root);
  };
  finalizers.add(finish);
  await setupWithCleanup(async () => {
    const rejected = await rejectionOf(fixtures.world("retained-browser-root", async fixture => {
      root = fixture.world.dir; browsers = fixture.world.browsers;
      await fixture.engine(async engine => {
        actual = engine;
        writeFileSync(join(browsers!, "uncollected-output"), "retained fixture evidence");
      }, { agentCommand: () => undefined });
    }, { browser: true }));
    expect((rejected as Error).message).toContain("browser files remain");
    expect(actual!.stopped).toBe(true);
    expect(existsSync(root!)).toBe(true);
    expect(existsSync(join(browsers!, "uncollected-output"))).toBe(true);
    expect(fixtures.retained.has(root!)).toBe(true);
  }, finish);
  await finish(); finalizers.delete(finish);
});
