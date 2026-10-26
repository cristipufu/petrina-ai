import { expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as commands from "@petrina/test-support/commands";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { waitFor } from "@petrina/test-support/fixtures";
import { learningReconciliationFixtures } from "../../fixtures/learning-reconciliation.js";

it("joins the native learning read before replacing its Engine and owns reads on the replacement", async () => {
  type Worlds = ReturnType<typeof learningReconciliationFixtures>;
  type World = Awaited<ReturnType<Worlds["fixture"]>>;
  const base = "# Instructions\n\nPrivate fixture instructions.\n", release = Promise.withResolvers<void>();
  const restorers: (() => void)[] = [];
  let worlds: Worlds | undefined, world: World | undefined, previous: World["engine"] | undefined;
  let firstRead: ReturnType<World["file"]> | undefined, restarting: Promise<void> | undefined, nextRead: ReturnType<World["file"]> | undefined;
  let held = false, nativeReadCompleted = false, nativeReadCompletedAtReplacement: boolean | undefined, cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= Promise.resolve().then(async () => {
    release.resolve();
    const restored = await Promise.allSettled(restorers.map(restore => Promise.resolve().then(restore)));
    const settled = await Promise.allSettled([
      () => firstRead, () => restarting, () => nextRead, () => previous?.shutdown(), () => world?.engine.shutdown(), () => world?.dispose(), () => worlds?.close(),
    ].map(stop => Promise.resolve().then<unknown>(stop)));
    const failed = [...restored, ...settled].filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Learning fixture work or cleanup could not be confirmed; uncertain roots retained");
  });
  await setupWithCleanup(async () => {
    worlds = learningReconciliationFixtures();
    const f = world = await worlds.fixture(base); previous = f.engine;
    const descriptor = Object.getOwnPropertyDescriptor(f, "engine")!;
    let selected = f.engine;
    // Observe the actual returned object's replacement assignment; every Engine remains a real native instance.
    restorers.push(() => Object.defineProperty(f, "engine", { ...descriptor, value: selected }));
    Object.defineProperty(f, "engine", { configurable: true, enumerable: true,
      get() { return selected; }, set(engine: World["engine"]) { nativeReadCompletedAtReplacement = nativeReadCompleted; selected = engine; },
    });
    const original = commands.gitWith, read = spyOn(commands, "gitWith"); restorers.push(() => read.mockRestore());
    read.mockImplementation((options, ...args) => {
      if (options.cwd !== f.copy || args[0] !== "cat-file" || args[2] !== "HEAD:AGENTS.md" || held) return original(options, ...args);
      held = true;
      return release.promise.then(async () => { const value = await original(options, ...args); nativeReadCompleted = true; return value; });
    });
    firstRead = f.file(); await waitFor(() => held, "the actual held instruction blob read", undefined, { during: firstRead });
    restarting = f.restart(); await previous.shutdown();
    expect(f.engine).toBe(previous); expect(existsSync(f.root)).toBe(true);
    release.resolve(); expect(await firstRead).toBe(base); await restarting;
    expect(nativeReadCompletedAtReplacement).toBe(true); expect(f.engine).not.toBe(previous);
    expect(f.scope().task.id).toBe(f.id);
    nextRead = f.file(); expect(await nextRead).toBe(base);
  }, cleanup);
  await cleanup();
  expect(existsSync(world!.root)).toBe(false);
});
