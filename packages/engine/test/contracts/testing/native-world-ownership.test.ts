import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
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
