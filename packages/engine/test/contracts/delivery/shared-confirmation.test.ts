import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";

import { describe, expect, it, spyOn } from "bun:test";

import * as github from "@petrina/repositories/github";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";

describe("explicit repository execution contexts", () => {
  it("reads shared PR states concurrently and ignores late replies after a driver starts", async () => {
    await withRepositoryRecords("parallel-pr-reads", {}, async ({ engine, task, run: ownRun }) => {
      await engine.waitUntilReady(); await completeAll([...engine.backgroundWork]);
      task.state = "pr-open";
      for (const [index, work] of task.repositories!.entries()) {
        const product = engine.s.products.find((product) => product.id === work.productId)!;
        work.source = { product, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", repo: product.repo, branch: "main", kind: "new-pr" } };
        work.pr = { number: index + 1, url: "https://example.test/pr", state: "open", openedAt: 1 };
      }
      let closing = false, pending: Promise<void> | undefined;
      const replies: ((value: Awaited<ReturnType<typeof github.prState>>) => void)[] = [];
      const read = spyOn(github, "prState");
      try {
        read.mockImplementation(() => closing ? Promise.resolve("open") : new Promise((resolve) => replies.push(resolve)));

        const settle = async () => {
          closing = true; for (const reply of replies) reply("open");
          try { await pending; } finally { engine.drivers.delete(task.id); }
        };
        await setupWithCleanup(async () => {
          pending = ownRun(() => engine["shipping"].monitor.pollPullRequests());
          expect(replies).toHaveLength(2);
          engine.drivers.set(task.id, new AbortController());
          replies[0]!("merged"); replies[1]!("closed");
          await pending;
          expect(task.repositories!.map((work) => work.pr!.state)).toEqual(["open", "open"]);
          expect(task.state as string).toBe("pr-open");

        }, settle);
        await settle();

      } finally { read.mockRestore(); }
    });
  });
});
