
import { afterAll, describe, expect, it, spyOn } from "bun:test";

import { removeDir, type World } from "../../support.js";
import * as github from "@petrina/repositories/github";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";

const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  it("reads shared PR states concurrently and ignores late replies after a driver starts", async () => {
    const { engine, task } = await fixture("parallel-pr-reads");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    task.state = "pr-open";
    for (const [index, work] of task.repositories!.entries()) {
      const product = engine.s.products.find((product) => product.id === work.productId)!;
      work.source = { product, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", repo: product.repo, branch: "main", kind: "new-pr" } };
      work.pr = { number: index + 1, url: "https://example.test/pr", state: "open", openedAt: 1 };
    }
    let closing = false, pending: Promise<void> | undefined;
    const replies: ((value: Awaited<ReturnType<typeof github.prState>>) => void)[] = [];
    const read = spyOn(github, "prState").mockImplementation(() => closing ? Promise.resolve("open") : new Promise((resolve) => replies.push(resolve)));
    try {
      pending = engine["shipping"].monitor.pollPullRequests();
      expect(replies).toHaveLength(2);
      engine.drivers.set(task.id, new AbortController());
      replies[0]!("merged"); replies[1]!("closed");
      await pending;
      expect(task.repositories!.map((work) => work.pr!.state)).toEqual(["open", "open"]);
      expect(task.state as string).toBe("pr-open");
    } finally {
      closing = true; for (const reply of replies) reply("open");
      await pending?.catch(() => {}); engine.drivers.delete(task.id); read.mockRestore(); await engine.shutdown();
    }
  });
});
