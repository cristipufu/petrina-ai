import { afterEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { completeAll } from "@petrina/core";
import { rejectionOf } from "@petrina/test-support/rejections";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { waitFor } from "../../fixtures.js";

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => { await completeAll([...cleanups].map(cleanup => cleanup())); });

function containsFailure(value: unknown, failure: unknown): boolean {
  return value === failure || value instanceof AggregateError && value.errors.some(error => containsFailure(error, failure));
}

for (const failure of [new Error("Controlled round rejection"), undefined]) {
  for (const inspectorFails of [false, true]) it(`joins a held round when its inspector ${inspectorFails ? "fails" : "acknowledges the expected rejection"} (${failure === undefined ? "undefined" : "Error"})`, async () => {
    const family = participantConversationFixtures(), release = Promise.withResolvers<void>();
    let f: Awaited<ReturnType<typeof family.fixture>> | undefined;
    let running: Promise<unknown> | undefined, closing: Promise<void> | undefined;
    let restore: (() => void) | undefined, cleaned: Promise<void> | undefined;
    let rawCompleted = false, inspected = false, completedAtReport: boolean | undefined, completedAtClose: boolean | undefined;
    const cleanup = () => cleaned ??= (async () => {
      release.resolve();
      const outcomes = await Promise.allSettled([running, closing, f?.engine.shutdown(), family.close()]);
      restore?.();
      if (f) {
        const root = dirname(f.fakes.dir);
        // The controlled hunt starts no actor. Independently require actual Engine shutdown and
        // actual round settlement before taking responsibility for an expected retained root.
        if (outcomes[2]!.status !== "fulfilled" || running && completedAtReport !== true)
          throw new AggregateError(outcomes.filter(result => result.status === "rejected").map(result => result.reason), "Round control cleanup was not confirmed; root retained");
        if (inspectorFails && running) {
          if (outcomes[0]!.status !== "rejected" || outcomes[0]!.reason !== failure
            || outcomes[3]!.status !== "rejected" || !containsFailure(outcomes[3]!.reason, failure))
            throw new Error("The failed inspector's original result and strict retention were not preserved");
          removeFixtureRoot(root);
        } else if (outcomes[3]!.status === "rejected") throw outcomes[3]!.reason;
      } else if (outcomes[3]!.status === "rejected") throw outcomes[3]!.reason;
    })().finally(() => { cleanups.delete(cleanup); });
    cleanups.add(cleanup);
    await setupWithCleanup(async () => {
      f = await family.fixture();
      const reviews = f.engine["reviews"], hunt = reviews["hunt"];
      restore = () => { reviews["hunt"] = hunt; };
      reviews["hunt"] = () => release.promise.then(() => { rawCompleted = true; throw failure; });
      const root = dirname(f.fakes.dir);
      running = f.withRound(1, raw => {
        inspected = true;
        if (inspectorFails) throw failure;
        return rejectionOf(raw).then(error => { expect(error).toBe(failure); });
      });
      const reported = () => { completedAtReport = rawCompleted; };
      void running.then(reported, reported);
      await waitFor(() => inspected, "the owned round inspector", undefined, { during: running });
      closing = f.close();
      const closed = () => { completedAtClose = rawCompleted; };
      void closing.then(closed, closed);
      await f.engine.shutdown();
      expect(existsSync(root)).toBe(true);
      release.resolve();
      if (inspectorFails) {
        expect(await rejectionOf(running)).toBe(failure);
        const error = await rejectionOf(closing);
        expect(error).toBeInstanceOf(AggregateError);
        expect(containsFailure(error, failure)).toBe(true);
        expect(existsSync(root)).toBe(true);
      } else {
        await running; await closing;
        expect(existsSync(root)).toBe(false);
      }
      expect(completedAtReport).toBe(true);
      expect(completedAtClose).toBe(true);
    }, cleanup);
    await cleanup();
  });
}
