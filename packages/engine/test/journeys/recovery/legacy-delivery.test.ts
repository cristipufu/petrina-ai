import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
import { acmeDemoProduct, installPreparedProduct } from "../../fixtures/prepared-product.js";
import { legacyDeliveryAgents } from "../../fixtures/legacy-delivery-agents.js";
// A delivery that the Petrina before this version was in the middle of, when its delivery agent still
// published with a GitHub login: after the update Petrina never acts on it by itself. It asks the
// coordinator to check GitHub and choose, and nothing happens until they do.
import { afterAll, describe, expect, it } from "bun:test";
import type { DeliveryMode, State, Task } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import type { Engine } from "../../engine.js";
import { coordinator, finish, git, itemOf, remoteRef, taskOf, until } from "../../support.js";

import { nativeWorldFixtures, type NativeWorld, type NativeWorldFixture } from "../../fixtures/native-worlds.js";
const fixtures = nativeWorldFixtures();
afterAll(fixtures.close);
const world = <T>(name: string, body: (world: NativeWorld, start: NativeWorldFixture["engine"]) => Promise<T>) => fixtures.world(name, async ({ world: made, engine }) => {
  const providers = legacyDeliveryAgents(made);
  const start: NativeWorldFixture["engine"] = (run, extra) => engine(run, { ...providers, ...extra });
  return body(made, start);
});

const NOTE = "This delivery was interrupted before Petrina was updated: check GitHub, then choose";
const asks = (state: State, taskId: string) => itemOf(state, taskId, "shipping") !== undefined;

/**
 * A task approved for delivery, saved the way the Petrina before this version left a delivery its
 * delivery agent was in the middle of: the old record, on the delivery step, on a product added before
 * Petrina kept its address. `oldAgent` does what that agent got done before Petrina stopped.
 */
async function interruptedBeforeUpdate(
  w: NativeWorld,
  first: Engine,
  mode: DeliveryMode,
  options: { oldAgent?: (task: Task, head: string) => unknown; state?: Task["state"]; oldItem?: boolean } = {},
): Promise<{ taskId: string; head: string; calls: number }> {
  const productId = installPreparedProduct(first, acmeDemoProduct(w.clone));
  first.setProductDelivery(productId, mode, true);
  const taskId = await queuePreparedDelivery(first, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
  const task = taskOf(await until(first, (state) => itemOf(state, taskId, "delivery") !== undefined, coordinator(["plan", "design"])), taskId);
  await first.shutdown();
  const head = (await gitOps.head(task.worktree!))!;
  await options.oldAgent?.(task, head);
  w.editSaved((state) => {
    // The old version's own question about an interrupted delivery, from before the update.
    const oldItem = { id: "old-item", taskId, kind: "shipping", title: "Shipping was interrupted", at: Date.now(), blocking: false, body: "Petrina could not confirm it went out." } as const;
    state.inbox = [...state.inbox.filter((item) => item.taskId !== taskId), ...(options.oldItem ? [oldItem] : [])];
    const saved = state.tasks.find((entry) => entry.id === taskId) as unknown as Record<string, unknown> & Task;
    const stage = saved.plan!.stages.findIndex((entry) => entry.roleId === "release-manager" && entry.kind === "do");
    expect(stage).toBeGreaterThan(-1);
    Object.assign(saved, {
      state: options.state ?? "running",
      stageIndex: stage,
      statusLine: "Shipper is working",
      shipping: { startedAt: Date.now() - 60_000, attempts: 1, head, boot: "a Petrina from before" },
    });
    delete (state.products[0] as unknown as Record<string, unknown>).remote;
  });
  return { taskId, head, calls: w.github().calls.length };
}

/** What the old delivery agent ran: plain git in the task's working copy, straight to GitHub. */
const pushToGitHub = (w: NativeWorld, cwd: string, ...refspecs: string[]) => git(cwd, "push", "-q", w.remote, ...refspecs);

async function versionCommit(cwd: string): Promise<string> {
  await git(cwd, "commit", "-q", "--allow-empty", "-m", "Version 0.1.0");
  return (await gitOps.head(cwd))!;
}

/** Nothing happened on its own: nothing made ready, no agent, no GitHub, no question about the address. */
function untouched(w: NativeWorld, state: State, taskId: string, calls: number): void {
  const task = taskOf(state, taskId);
  expect(task.state).toBe("needs-you");
  expect(task.statusLine).toBe(NOTE);
  expect(task.shipping).toEqual({ moves: 0, failures: 0, carriedOver: true });
  expect(state.inbox.filter((item) => item.taskId === taskId).map((item) => item.kind)).toEqual(["shipping"]);
  expect(itemOf(state, taskId, "shipping")!.body).toStartWith(NOTE);
  expect(task.timeline.some((entry) => entry.text.startsWith("Ready to publish"))).toBe(false);
  expect(w.script().releaseManagerPrompts).toBeUndefined();
  expect(w.github().calls.length).toBe(calls);
}

describe.concurrent("A delivery interrupted before Petrina was updated", () => {
  it("does nothing on its own until the coordinator chooses, across restarts", async () => {
    await world("upgrade-waits", async (w, start) => {
    let bumped = "";
    const { taskId, calls } = await start(first => interruptedBeforeUpdate(w, first, "release", {
      oldItem: true,
      oldAgent: async (task) => {
        bumped = await versionCommit(task.worktree!);
        await pushToGitHub(w, task.worktree!, "HEAD:refs/heads/main", "HEAD:refs/tags/v0.1.0");
        w.setGitHub((github) => github.releases.push({ tagName: "v0.1.0", url: "https://github.com/acme/demo/releases/tag/v0.1.0", publishedAt: new Date().toISOString(), isDraft: false, name: "v0.1.0", body: "A greeting." }));
      },
    }));
    let state = await start(async engine => {

      // The old version's question is replaced by the coordinator's choice.
      let state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);
      expect(taskOf(state, taskId).timeline.filter((entry) => entry.text === NOTE)).toHaveLength(1);

      // "Check again" has nothing to look up: it asks again, and still nothing happens.
      engine.checkShipping(itemOf(state, taskId, "shipping")!.id);
      state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);

      // A restart changes nothing, and adds no question: one note per time Petrina asked.
      await engine.shutdown();
      return state;
    });
    await start(async again => {
      try {
        await again.waitUntilReady(); await Promise.all([...again.backgroundWork]);
        state = await until(again, (current) => asks(current, taskId));
        untouched(w, state, taskId, calls);
        expect(taskOf(state, taskId).timeline.filter((entry) => entry.text === NOTE)).toHaveLength(2);

        // "It went out (mark as done)": the coordinator found the release on GitHub.
        again.markDone(itemOf(state, taskId, "shipping")!.id);
        state = await until(again, (current) => taskOf(current, taskId).cleanup?.pullRequest === "none");
        const task = taskOf(state, taskId);
        expect(task.state).toBe("done");
        expect(task.shipping).toBeUndefined();
        const followUp = w.github().calls.slice(calls);
        expect(followUp.some((call) => call[0] === "pr" && call[1] === "list")).toBe(true);
        expect(followUp.every((call) => call[0] === "pr" && call[1] === "list" || call[0] === "repo" && call[1] === "view")).toBe(true);
        expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v0.1.0"]);
        expect(await remoteRef(w.remote, "refs/heads/main")).toBe(bumped);
      } finally {
        await again.shutdown();
      }

    });
    });
  });

  it("never releases twice after “Ship it again” when the old delivery agent already pushed the version's tag", async () => {
    await world("upgrade-pushed", async (w, start) => {
    let bumped = "";
    const { taskId, calls } = await start(first => interruptedBeforeUpdate(w, first, "release", {
      oldAgent: async (task) => {
        bumped = await versionCommit(task.worktree!);
        await pushToGitHub(w, task.worktree!, "HEAD:refs/heads/main", "HEAD:refs/tags/v0.1.0");
      },
    }));
    await start(async engine => {
    try {
      const state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);
      engine.shipAgain(itemOf(state, taskId, "shipping")!.id);
      const approval = await until(engine, current => itemOf(current, taskId, "delivery") !== undefined, coordinator(["plan", "design"]));
      expect(taskOf(approval, taskId).shipping).toBeUndefined();
      expect(taskOf(approval, taskId).approvedFor).toBeUndefined();
      expect(taskOf(approval, taskId).timeline.some(entry => entry.text.startsWith("Ready to publish"))).toBe(false);
      expect(w.github().releases).toEqual([]);
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("The tag v0.1.0 already exists on GitHub");
      expect(w.github().releases).toEqual([]);
      expect(await remoteRef(w.remote, "refs/tags/v0.1.0")).toBe(bumped);
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(bumped);
    } finally {
      await engine.shutdown();
    }

    });
    });
  });

  it("keeps the note on the task when the coordinator cancels it, and still looks nothing up", async () => {
    await world("upgrade-cancel", async (w, start) => {
    const { taskId, calls } = await start(first => interruptedBeforeUpdate(w, first, "local"));
    const note = "Cancelled. This delivery was interrupted before Petrina was updated: check GitHub for what went out";
    await start(async engine => {

    try {
      const state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);
      engine.cancel(taskId);
      await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
      const task = taskOf(engine.getState(), taskId);
      expect(task.state).toBe("cancelled");
      expect(task.statusLine).toBe(note);
      expect(task.shipping?.carriedOver).toBe(true);
      expect(engine.getState().inbox.filter((item) => item.taskId === taskId)).toEqual([]);
      expect(await gitOps.revParse(w.clone, "main")).toBe(w.initial);
    } finally {
      await engine.shutdown();
    }

    });
    await start(async again => {
    try {
      await again.waitUntilReady(); await Promise.all([...again.backgroundWork]);
      const task = taskOf(again.getState(), taskId);
      expect(task.state).toBe("cancelled");
      expect(task.statusLine).toBe(note);
      expect(again.getState().inbox.filter((item) => item.taskId === taskId)).toEqual([]);
      expect(w.github().calls.length).toBe(calls);
    } finally {
      await again.shutdown();
    }

    });
    });
  });

});
