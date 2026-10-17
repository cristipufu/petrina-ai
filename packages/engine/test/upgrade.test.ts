// A delivery that the Petrina before this version was in the middle of, when its delivery agent still
// published with a GitHub login: after the update Petrina never acts on it by itself. It asks the
// coordinator to check GitHub and choose, and nothing happens until they do.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import type { DeliveryMode, State, Task } from "@petrina/core";
import type { Engine } from "../src/engine.js";
import { coordinator, finish, git, itemOf, makeWorld, removeDir, remoteRef, taskOf, until, type World } from "./support.js";

const worlds: World[] = [];
const world = (name: string) => {
  const made = makeWorld(name);
  worlds.push(made);
  return made;
};
afterAll(() => {
  for (const made of worlds) removeDir(made.dir);
});

const NOTE = "This delivery was interrupted before Petrina was updated: check GitHub, then choose";
const asks = (state: State, taskId: string) => itemOf(state, taskId, "shipping") !== undefined;

/**
 * A task approved for delivery, saved the way the Petrina before this version left a delivery its
 * delivery agent was in the middle of: the old record, on the delivery step, on a product added before
 * Petrina kept its address. `oldAgent` does what that agent got done before Petrina stopped.
 */
async function interruptedBeforeUpdate(
  w: World,
  mode: DeliveryMode,
  options: { oldAgent?: (task: Task, head: string) => void; state?: Task["state"]; oldItem?: boolean } = {},
): Promise<{ engine: Engine; taskId: string; head: string; calls: number }> {
  const first = w.start();
  const productId = await first.addProduct(w.clone);
  first.setProductDelivery(productId, mode, true);
  const taskId = first.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
  const task = taskOf(await until(first, (state) => itemOf(state, taskId, "delivery") !== undefined, coordinator(["plan", "design"])), taskId);
  first.shutdown();
  const head = git(task.worktree!, "rev-parse", "HEAD");
  options.oldAgent?.(task, head);
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
  return { engine: w.start(), taskId, head, calls: w.github().calls.length };
}

/** What the old delivery agent ran: plain git in the task's working copy, straight to GitHub. */
const pushToGitHub = (w: World, cwd: string, ...refspecs: string[]) => execFileSync("git", ["push", "-q", w.remote, ...refspecs], { cwd });

function versionCommit(cwd: string): string {
  git(cwd, "commit", "-q", "--allow-empty", "-m", "Version 0.1.0");
  return git(cwd, "rev-parse", "HEAD");
}

/** Nothing happened on its own: nothing made ready, no agent, no GitHub, no question about the address. */
function untouched(w: World, state: State, taskId: string, calls: number): void {
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
    const w = world("upgrade-waits");
    let bumped = "";
    const { engine, taskId, calls } = await interruptedBeforeUpdate(w, "release", {
      oldItem: true,
      oldAgent: (task) => {
        bumped = versionCommit(task.worktree!);
        pushToGitHub(w, task.worktree!, "HEAD:refs/heads/main", "HEAD:refs/tags/v0.1.0");
        w.setGitHub((github) => github.releases.push({ tagName: "v0.1.0", url: "https://github.com/acme/demo/releases/tag/v0.1.0", publishedAt: new Date().toISOString(), isDraft: false, name: "v0.1.0", body: "A greeting." }));
      },
    });
    try {
      // The old version's question is replaced by the coordinator's choice.
      let state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);
      expect(taskOf(state, taskId).timeline.filter((entry) => entry.text === NOTE)).toHaveLength(1);

      // "Check again" has nothing to look up: it asks again, and still nothing happens.
      engine.checkShipping(itemOf(state, taskId, "shipping")!.id);
      state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);

      // A restart changes nothing, and adds no question: one note per time Petrina asked.
      engine.shutdown();
      const again = w.start();
      try {
        await Bun.sleep(300);
        state = await until(again, (current) => asks(current, taskId));
        untouched(w, state, taskId, calls);
        expect(taskOf(state, taskId).timeline.filter((entry) => entry.text === NOTE)).toHaveLength(2);

        // "It went out (mark as done)": the coordinator found the release on GitHub.
        again.markDone(itemOf(state, taskId, "shipping")!.id);
        const task = taskOf(again.getState(), taskId);
        expect(task.state).toBe("done");
        expect(task.shipping).toBeUndefined();
        expect(w.github().calls.length).toBe(calls);
        expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v0.1.0"]);
        expect(remoteRef(w.remote, "refs/heads/main")).toBe(bumped);
      } finally {
        again.shutdown();
      }
    } finally {
      engine.shutdown();
    }
  });

  it("asks for the delivery approval again after “Ship it again”, then ships it with the usual checks", async () => {
    const w = world("upgrade-ship-again");
    const { engine, taskId, calls } = await interruptedBeforeUpdate(w, "pull-request");
    try {
      let state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);

      engine.shipAgain(itemOf(state, taskId, "shipping")!.id);
      // The task asks for approval before delivery: Ship it again asks for it, and nothing is made ready before it.
      state = await until(engine, (current) => itemOf(current, taskId, "delivery") !== undefined, coordinator(["plan", "design"]));
      expect(taskOf(state, taskId).shipping).toBeUndefined();
      expect(taskOf(state, taskId).approvedFor).toBeUndefined();
      expect(taskOf(state, taskId).timeline.some((entry) => entry.text.startsWith("Ready to publish"))).toBe(false);
      expect(w.github().prs).toEqual([]);

      // The coordinator confirms the address the product was added with, once, and it goes out.
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("pr-open");
      expect(task.pr?.number).toBe(1);
      expect(w.github().prs).toHaveLength(1);
      expect(task.timeline.filter((entry) => entry.text.startsWith("Ready to publish"))).toHaveLength(1);
    } finally {
      engine.shutdown();
    }
  });

  it("never releases twice after “Ship it again” when the old delivery agent already pushed the version's tag", async () => {
    const w = world("upgrade-pushed");
    let bumped = "";
    const { engine, taskId, calls } = await interruptedBeforeUpdate(w, "release", {
      oldAgent: (task) => {
        bumped = versionCommit(task.worktree!);
        pushToGitHub(w, task.worktree!, "HEAD:refs/heads/main", "HEAD:refs/tags/v0.1.0");
      },
    });
    try {
      const state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);
      engine.shipAgain(itemOf(state, taskId, "shipping")!.id);
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("The tag v0.1.0 already exists on GitHub");
      expect(w.github().releases).toEqual([]);
      expect(remoteRef(w.remote, "refs/tags/v0.1.0")).toBe(bumped);
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(bumped);
    } finally {
      engine.shutdown();
    }
  });

  it("keeps the note on the task when the coordinator cancels it, and still looks nothing up", async () => {
    const w = world("upgrade-cancel");
    const { engine, taskId, calls } = await interruptedBeforeUpdate(w, "local");
    const note = "Cancelled. This delivery was interrupted before Petrina was updated: check GitHub for what went out";
    try {
      const state = await until(engine, (current) => asks(current, taskId));
      untouched(w, state, taskId, calls);
      engine.cancel(taskId);
      await Bun.sleep(300);
      const task = taskOf(engine.getState(), taskId);
      expect(task.state).toBe("cancelled");
      expect(task.statusLine).toBe(note);
      expect(task.shipping?.carriedOver).toBe(true);
      expect(engine.getState().inbox.filter((item) => item.taskId === taskId)).toEqual([]);
      expect(git(w.clone, "rev-parse", "main")).toBe(w.initial);
    } finally {
      engine.shutdown();
    }
    const again = w.start();
    try {
      await Bun.sleep(300);
      const task = taskOf(again.getState(), taskId);
      expect(task.state).toBe("cancelled");
      expect(task.statusLine).toBe(note);
      expect(again.getState().inbox.filter((item) => item.taskId === taskId)).toEqual([]);
      expect(w.github().calls.length).toBe(calls);
    } finally {
      again.shutdown();
    }
  });

  it("keeps the note on a task that was already cancelled, and waits on a paused one until it is resumed", async () => {
    const cancelled = world("upgrade-was-cancelled");
    const before = await interruptedBeforeUpdate(cancelled, "pull-request", { state: "cancelled" });
    try {
      await Bun.sleep(300);
      const task = taskOf(before.engine.getState(), before.taskId);
      expect(task.state).toBe("cancelled");
      expect(task.statusLine).toBe("Cancelled. This delivery was interrupted before Petrina was updated: check GitHub for what went out");
      expect(task.shipping).toEqual({ moves: 0, failures: 0, carriedOver: true });
      expect(cancelled.github().calls.length).toBe(before.calls);
    } finally {
      before.engine.shutdown();
    }

    const paused = world("upgrade-paused");
    const { engine, taskId, calls } = await interruptedBeforeUpdate(paused, "pull-request", { state: "paused" });
    try {
      await Bun.sleep(300);
      expect(taskOf(engine.getState(), taskId).state).toBe("paused");
      expect(engine.getState().inbox.filter((item) => item.taskId === taskId)).toEqual([]);
      engine.resume(taskId);
      const state = await until(engine, (current) => asks(current, taskId));
      untouched(paused, state, taskId, calls);
    } finally {
      engine.shutdown();
    }
  });
});
