import { acmeDemoProduct, installPreparedProduct } from "../../fixtures/prepared-product.js";
import { legacyDeliveryAgents } from "../../fixtures/legacy-delivery-agents.js";
import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
// A delivery interrupted at any step never goes out twice: each publishing step is saved before it starts,
// and what went out is looked up first after a restart, a pause, a Retry or a cancel.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, type ShippingRecord, type State } from "@petrina/core";
import type { Engine } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorldFixture } from "../../fixtures/native-worlds.js";
import { branchName } from "@petrina/repositories/git";
import { finish, git, gitWith, itemOf, remoteRef, taskOf, testGitEnv, until, SLOW } from "../../support.js";

const worlds = nativeWorldFixtures();
const world = async <T>(name: string, body: (fixture: NativeWorldFixture) => Promise<T>, options: { allowOverlap?: true } = {}): Promise<T> => {
  let directory: string | undefined;
  return worlds.world(name, fixture => { directory = fixture.world.dir; return body(fixture); }, options, {
    stopPeers() {
      if (directory) for (const name of readdirSync(directory)) if (name === "hold" || name.startsWith("hold-")) rmSync(join(directory, name), { force: true });
    },
  });
};
afterAll(worlds.close);

/** Start a task that delivers without asking; the fake GitHub holds `command` after doing its work. */
async function startHeld<T>(fixture: NativeWorldFixture, mode: "pull-request" | "release", command: string, body: (held: { engine: Engine; taskId: string; hold: string }) => Promise<T>): Promise<T> {
  const w = fixture.world;
  const hold = join(w.dir, `hold-${command.replace(" ", "-")}`);
  writeFileSync(hold, "");
  w.setGitHub((github) => (github.hold = { command, file: hold }));
  return fixture.engine(async engine => {
    const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
    engine.setProductDelivery(productId, mode, false);
    const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
    const respond = (current: Engine, state: State) => {
      for (const item of state.inbox) if (item.kind === "permission") current.allow(item.id, "once");
    };
    const started = Date.now();
    for (;;) {
      respond(engine, engine.getState());
      if (existsSync(`${hold}.reached`)) break;
      if (Date.now() - started > 60_000 * SLOW) throw new Error("the fake GitHub was never reached");
      await Bun.sleep(30);
    }
    return body({ engine, taskId, hold });
  }, legacyDeliveryAgents(w));
}

/** Edit the real stopped generation's saved record, then hand the actual successor to its callback. */
async function stuckThenEdit<T>(fixture: NativeWorldFixture, mode: "pull-request" | "release", failing: Record<string, number>, edit: (shipping: ShippingRecord) => unknown, body: (run: { engine: Engine; taskId: string }) => Promise<T>): Promise<T> {
  const w = fixture.world;
  w.setGitHub((github) => (github.fail = failing));
  const taskId = await fixture.engine(async engine => {
    const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
    engine.setProductDelivery(productId, mode, false);
    const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
    const task = taskOf(await finish(engine, taskId), taskId);
    expect(task.state).toBe("failed");
    await engine.shutdown();
    return taskId;
  }, legacyDeliveryAgents(w));
  let editing: unknown;
  w.editSaved((state) => { editing = edit(state.tasks.find((entry) => entry.id === taskId)!.shipping as ShippingRecord); });
  await editing;
  return fixture.engine(async engine => {
    engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
    return body({ engine, taskId });
  }, legacyDeliveryAgents(w));
}

describe.concurrent("A delivery interrupted at any step never goes out twice", () => {
  it("records the pull request GitHub opened just before Petrina stopped", async () => {
    await world("restart-open", async fixture => {
      const w = fixture.world;

      await startHeld(fixture, "pull-request", "pr create", async (first) => {

      expect(taskOf(first.engine.getState(), first.taskId).shipping?.step).toBe("open");
      const stopping = first.engine.shutdown();
      await completeAll([stopping, fixture.engine(async engine => {

      try {
        const task = taskOf(await finish(engine, first.taskId), first.taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe("pr-open");
        expect(task.pr?.number).toBe(1);
        expect(w.github().prs).toHaveLength(1);
        expect(w.github().calls.filter((call) => call[1] === "create")).toHaveLength(1);
        expect(task.timeline.map((entry) => entry.text)).toContain("Found after a restart that it had already gone out: pull request #1");
        expect(task.timeline.filter((entry) => entry.text.startsWith("Ready to publish"))).toHaveLength(1);
      } finally {
        rmSync(first.hold, { force: true });
        await Promise.all([stopping, engine.shutdown()]);
      }


      }, legacyDeliveryAgents(w))]);
      });
    }, { allowOverlap: true });
  });

  it("pushes the same commit again when its push went through but was not saved, overwriting nothing", async () => {
    await world("repeat-push", async fixture => {
      const w = fixture.world;

      await stuckThenEdit(fixture, "pull-request", { "pr create": 1 }, (shipping) => (shipping.step = "push"), async ({ engine, taskId }) => {

      try {
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("pr-open");
        expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBe(await git(task.worktree!, "rev-parse", "HEAD"));
        expect(w.github().prs).toHaveLength(1);
        expect(task.timeline.filter((entry) => entry.text.startsWith("Ready to publish"))).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      });
    });
  });

  it("records the release GitHub published just before Petrina stopped, with the same version", async () => {
    await world("restart-release", async fixture => {
      const w = fixture.world;

      await startHeld(fixture, "release", "release create", async (first) => {

      const stopping = first.engine.shutdown();
      await completeAll([stopping, fixture.engine(async engine => {

      try {
        const task = taskOf(await finish(engine, first.taskId), first.taskId);
        expect(task.error).toBeUndefined();
        expect(task.release?.tag).toBe("v0.1.0");
        expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v0.1.0"]);
        expect(task.timeline.map((entry) => entry.text)).toContain("Found after a restart that it had already gone out: release v0.1.0");
      } finally {
        rmSync(first.hold, { force: true });
        await Promise.all([stopping, engine.shutdown()]);
      }


      }, legacyDeliveryAgents(w))]);
      });
    }, { allowOverlap: true });
  });

  it("finds a release push that went through but was not saved, and publishes the release on that tag with no new version", async () => {
    await world("release-pushed", async fixture => {
      const w = fixture.world;

      await stuckThenEdit(fixture, "release", { "release create": 1 }, (shipping) => {
        shipping.pushed = false;
        shipping.step = "push";
      }, async ({ engine, taskId }) => {

      try {
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.error).toBeUndefined();
        expect(task.release?.tag).toBe("v0.1.0");
        expect(await remoteRef(w.remote, "refs/tags/v0.1.1")).toBeUndefined();
        expect(task.timeline.some((entry) => entry.text.startsWith("Checked: main and the tag v0.1.0 are already on GitHub"))).toBe(true);
        expect(w.script().releaseManagerPrompts).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      });
    });
  });

  for (const how of ["moved", "gone"] as const) {
    it(`creates no release on Retry when the tag on GitHub ${how === "moved" ? "moved" : "went away"} after Petrina's push`, async () => {
    await world(`release-tag-${how}`, async fixture => {
      const w = fixture.world;

        await stuckThenEdit(fixture, "release", { "release create": 1 }, async (shipping) => {
          expect(shipping.pushed).toBe(true);
          const tested = shipping.prepared!.tested;
          if (how === "gone") {
            await gitWith({}, "--git-dir", w.remote, "update-ref", "-d", "refs/tags/v0.1.0");
            return;
          }
          // Someone points the tag at untested work on top of the tested commit.
          const env = testGitEnv({ ...process.env, GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: "s@example.com", GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: "s@example.com" });
          const other = await gitWith({ env }, "--git-dir", w.remote, "commit-tree", `${tested}^{tree}`, "-p", tested, "-m", "Untested change");
          await gitWith({}, "--git-dir", w.remote, "update-ref", "refs/tags/v0.1.0", other);
        }, async ({ engine, taskId }) => {

        try {
          const task = taskOf(await finish(engine, taskId), taskId);
          expect(task.state).toBe("failed");
          expect(task.error).toContain(how === "gone" ? "The tag v0.1.0 on GitHub is gone" : "The tag v0.1.0 on GitHub is at");
          expect(task.error).toContain("so Petrina created no release");
          expect(task.release).toBeUndefined();
          expect(w.github().releases).toEqual([]);
          // Only the first, failed attempt ever reached GitHub's release creation.
          expect(w.github().calls.filter((call) => `${call[0]} ${call[1]}` === "release create")).toHaveLength(1);
        } finally {
          await engine.shutdown();
        }


      });
    });
  });
  }

  for (const where of ["preparing", "publishing"] as const) {
    it(`never takes a release published just before shipping for this delivery, interrupted while ${where}`, async () => {
    await world(`release-before-${where}`, async fixture => {
      const w = fixture.world;

        // v1.0.0 came out just before this delivery started.
        await gitWith({}, "--git-dir", w.remote, "update-ref", "refs/tags/v1.0.0", w.initial);
        w.setGitHub((github) => github.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/demo/releases/tag/v1.0.0", publishedAt: new Date().toISOString(), isDraft: false, name: "v1.0.0", body: "" }));
        const hold = join(w.dir, "hold-release-manager");
        if (where === "preparing") {
          // The Release Manager hangs, and Petrina stops while it does.
          writeFileSync(hold, "");
          w.setScript((script) => (script.hold = { title: "Add a greeting", file: hold, role: "release manager" }));
          await fixture.engine(async first => {
            const productId = installPreparedProduct(first, acmeDemoProduct(w.clone));
            first.setProductDelivery(productId, "release", false);
            const taskId = await queuePreparedDelivery(first, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
            await until(first, () => existsSync(`${hold}.reached`));
            expect(taskOf(first.getState(), taskId).shipping?.tag).toBe("v1.0.1");
            const stopping = first.shutdown();
            w.setScript((script) => delete script.hold);
            await completeAll([stopping, fixture.engine(engine => completed(engine, taskId, stopping), legacyDeliveryAgents(w))]);
          });
        } else {
          // Main and the tag went out; Petrina stopped before the release did.
          await stuckThenEdit(fixture, "release", { "release create": 1 }, (shipping) => expect(shipping.step).toBe("release"), async ({ engine, taskId }) => completed(engine, taskId));
        }
        async function completed(engine: Engine, taskId: string, stopping?: Promise<void>) {
        try {
          const task = taskOf(await finish(engine, taskId), taskId);
          expect(task.error).toBeUndefined();
          expect(task.state).toBe("done");
          expect(task.release?.tag).toBe("v1.0.1");
          expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.0.0", "v1.0.1"]);
          expect(await remoteRef(w.remote, "refs/tags/v1.0.1")).toBe(await remoteRef(w.remote, "refs/heads/main"));
          expect(await remoteRef(w.remote, "refs/tags/v1.0.0")).toBe(w.initial);
          expect(task.timeline.some((entry) => entry.text.includes("v1.0.0") && entry.text.includes("already gone out"))).toBe(false);
        } finally {
          rmSync(hold, { force: true });
          await Promise.all([stopping, engine.shutdown()]);
        }


        }

    }, { allowOverlap: where === "preparing" ? true : undefined });
  });
  }

  it("finds a local update that went through but was not saved", async () => {
    await world("local-updated", async fixture => {
      const w = fixture.world;

      let { taskId, tested, task } = await fixture.engine(async engine => {

      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "local", false);
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("done");
      const tested = await git(w.clone, "rev-parse", "main");
      await engine.shutdown();
        return { taskId, tested, task };
      }, legacyDeliveryAgents(w));
      // As if Petrina stopped right after git moved main, before it saved that.
      w.editSaved((state) => {
        const saved = state.tasks.find((entry) => entry.id === taskId) as unknown as Record<string, unknown>;
        for (const key of ["landed", "finishedAt"]) delete saved[key];
        Object.assign(saved, {
          state: "waiting",
          column: "ready",
          shipping: { start: tested, base: w.initial, prepared: { tested, summary: "Ready." }, step: "update", moves: 0, failures: 0 },
        });
      });
      await fixture.engine(async engine => {
      try {
        task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("done");
        expect(task.landed?.sha).toBe(tested.slice(0, 7));
        expect(task.timeline.map((entry) => entry.text)).toContain(`Found after a restart that it had already gone out: main has the work (${tested.slice(0, 7)})`);
      } finally {
        await engine.shutdown();
      }


      }, legacyDeliveryAgents(w));
    });
  });

  it("starts no new step while paused, and on resume records what went out", async () => {
    await world("pause", async fixture => {
      const w = fixture.world;

      await startHeld(fixture, "pull-request", "pr create", async ({ engine, taskId, hold }) => {

      try {
        engine.pause(taskId);
        rmSync(hold);
        await until(engine, () => w.github().prs.length === 1 && taskOf(engine.getState(), taskId).state === "paused");
        await Bun.sleep(300);
        expect(taskOf(engine.getState(), taskId).pr).toBeUndefined();
        engine.resume(taskId);
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("pr-open");
        expect(w.github().prs).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      });
    });
  });

  it("keeps the link to a pull request that went out while the task was cancelled, and keeps it cancelled", async () => {
    await world("cancel", async fixture => {

      await startHeld(fixture, "pull-request", "pr create", async ({ engine, taskId, hold }) => {

      try {
        engine.cancel(taskId);
        rmSync(hold);
        const task = taskOf(await until(engine, (current) => !!taskOf(current, taskId).pr), taskId);
        expect(task.state).toBe("cancelled");
        expect(task.column).toBe("done");
        expect(task.pr).toMatchObject({ number: 1, url: "https://github.com/acme/demo/pull/1" });
        expect(task.timeline.map((entry) => entry.text)).toContain("Pull request #1 went out while you cancelled it: https://github.com/acme/demo/pull/1");
      } finally {
        await engine.shutdown();
      }


      });
    });
  });

  it("keeps the link when GitHub opened the pull request but its answer was lost as the task was cancelled", async () => {
    await world("cancel-lost", async fixture => {
      const w = fixture.world;

      w.setGitHub((github) => (github.lose = { "pr create": 1 }));
      await startHeld(fixture, "pull-request", "pr create", async ({ engine, taskId, hold }) => {

      try {
        engine.cancel(taskId);
        rmSync(hold);
        const task = taskOf(await until(engine, (current) => !!taskOf(current, taskId).pr), taskId);
        expect(task.state).toBe("cancelled");
        expect(task.statusLine).toBe("Cancelled");
        expect(task.pr).toMatchObject({ number: 1, url: "https://github.com/acme/demo/pull/1" });
        expect(task.shipping).toBeUndefined();
        expect(w.github().prs).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      });
    });
  });

  it("looks again after a restart when GitHub could not be asked as the task was cancelled", async () => {
    await world("cancel-unreachable", async fixture => {
      const w = fixture.world;

      w.setGitHub((github) => (github.lose = { "pr create": 1 }));
      const first = await startHeld(fixture, "pull-request", "pr create", async first => {

      first.engine.cancel(first.taskId);
      // GitHub stops answering just as the pull request goes out.
      w.setGitHub((github) => (github.fail = { "pr list": 1 }));
      rmSync(first.hold);
      await until(first.engine, () => w.github().fail?.["pr list"] === 0);
      await Bun.sleep(300);
      let task = taskOf(first.engine.getState(), first.taskId);
      expect(task.pr).toBeUndefined();
      expect(task.shipping?.step).toBe("open");
      await first.engine.shutdown();
        return { taskId: first.taskId, task };
      });
      let task = first.task;
      await fixture.engine(async engine => {

      try {
        task = taskOf(await until(engine, (current) => !!taskOf(current, first.taskId).pr), first.taskId);
        expect(task.state).toBe("cancelled");
        expect(task.pr?.number).toBe(1);
        expect(task.timeline.map((entry) => entry.text)).toContain("Pull request #1 went out while you cancelled it: https://github.com/acme/demo/pull/1");
        expect(w.github().calls.filter((call) => call[1] === "create")).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      }, legacyDeliveryAgents(w));
    });
  });

  for (const how of ["released", "pushed"] as const) {
    it(`keeps a release that went out as the task was cancelled${how === "pushed" ? ", and says when only its push did" : ""}`, async () => {
    await world(`cancel-${how}`, async fixture => {
      const w = fixture.world;

        const hold = join(w.dir, "hold");
        writeFileSync(hold, "");
        // Held right after GitHub created the release; or the release creation fails once main and the tag went out.
        w.setGitHub((github) => (how === "released" ? (github.hold = { command: "release create", file: hold }) : (github.fail = { "release create": 1 })));
        await fixture.engine(async engine => {

        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          engine.setProductDelivery(productId, "release", false);
          const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
          if (how === "released") await until(engine, () => existsSync(`${hold}.reached`));
          else expect(taskOf(await finish(engine, taskId), taskId).shipping?.step).toBe("release");
          engine.cancel(taskId);
          rmSync(hold);
          const task = taskOf(await until(engine, (current) => !taskOf(current, taskId).shipping), taskId);
          expect(task.state).toBe("cancelled");
          expect(await remoteRef(w.remote, "refs/tags/v0.1.0")).toBe(await remoteRef(w.remote, "refs/heads/main"));
          if (how === "released") {
            expect(task.release?.tag).toBe("v0.1.0");
            expect(task.timeline.map((entry) => entry.text)).toContain("Release v0.1.0 went out while you cancelled it: https://github.com/acme/demo/releases/tag/v0.1.0");
          } else {
            expect(task.release).toBeUndefined();
            expect(w.github().releases).toEqual([]);
            expect(task.timeline.some((entry) => entry.text.startsWith("main and the tag v0.1.0 went out to GitHub at") && entry.text.endsWith("while you cancelled it, with no release for that tag"))).toBe(true);
          }
        } finally {
          await engine.shutdown();
        }


      }, legacyDeliveryAgents(w));
    });
  });
  }


  it("waits for Retry when GitHub cannot be asked, and never takes that for an empty answer", async () => {
    await world("lookup", async fixture => {
      const w = fixture.world;

      w.setGitHub((github) => (github.fail = { "pr list": 1 }));
      await fixture.engine(async engine => {

      try {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        engine.setProductDelivery(productId, "pull-request", false);
        const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        let task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("failed");
        expect(task.error).toContain("could not check GitHub for this task's pull request");
        expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();
        engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
        task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("pr-open");
      } finally {
        await engine.shutdown();
      }


      }, legacyDeliveryAgents(w));
    });
  });

  for (const mode of ["pull-request", "release"] as const) {
    it(`looks again when GitHub says a ${mode === "pull-request" ? "pull request" : "release"} already exists, and records it when it matches`, async () => {
    await world(`exists-${mode}`, async fixture => {
      const w = fixture.world;

        const create = mode === "pull-request" ? "pr create" : "release create";
        // The first create goes through but its answer is lost; the next listing lags behind.
        w.setGitHub((github) => (github.lose = { [create]: 1 }));
        await fixture.engine(async engine => {

        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          engine.setProductDelivery(productId, mode, false);
          const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
          let task = taskOf(await finish(engine, taskId), taskId);
          expect(task.state).toBe("failed");
          expect(task.error).toContain("GitHub did not");
          w.setGitHub((github) => (github.stale = { [mode === "pull-request" ? "pr list" : "release view"]: 1 }));
          engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
          task = taskOf(await finish(engine, taskId), taskId);
          expect(task.error).toBeUndefined();
          expect(task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
          expect(w.github().calls.filter((call) => `${call[0]} ${call[1]}` === create)).toHaveLength(2);
          expect(mode === "pull-request" ? w.github().prs.length : w.github().releases.length).toBe(1);
        } finally {
          await engine.shutdown();
        }


      }, legacyDeliveryAgents(w));
    });
  });
  }

  it("records a merged or closed pull request found after an interruption, even with its branch deleted", async () => {
    await world("merged", async fixture => {
      const w = fixture.world;

      const first = await startHeld(fixture, "pull-request", "pr create", async first => {

      const saved = structuredClone(taskOf(first.engine.getState(), first.taskId).shipping) as ShippingRecord;
      const branch = taskOf(first.engine.getState(), first.taskId).branch!;
      const stopping = first.engine.shutdown();
      rmSync(first.hold);
      await until(first.engine, () => w.github().prs.length === 1);
      await stopping;
        return { taskId: first.taskId, saved, branch };
      });
      const { saved, branch } = first;
      // The branch is deleted on GitHub after the pull request closes; GitHub keeps its last commit.
      await gitWith({}, "--git-dir", w.remote, "update-ref", "-d", `refs/heads/${branch}`);
      for (const state of ["MERGED", "CLOSED"] as const) {
        w.setGitHub((github) => {
          github.prs[0]!.state = state;
          delete github.hold;
        });
        w.editSaved((current) => {
          const task = current.tasks.find((entry) => entry.id === first.taskId) as unknown as Record<string, unknown>;
          for (const key of ["pr", "finishedAt"]) delete task[key];
          Object.assign(task, { state: "waiting", column: "ready", shipping: saved });
        });
        await fixture.engine(async engine => {

        try {
          const task = taskOf(await finish(engine, first.taskId), first.taskId);
          expect(task.error).toBeUndefined();
          expect(task.state).toBe("done");
          expect(task.pr?.state).toBe(state === "MERGED" ? "merged" : "closed");
          expect(task.statusLine).toBe(state === "MERGED" ? "Merged #1 on GitHub" : "Closed #1 without merging");
          expect(w.github().prs).toHaveLength(1);
        } finally {
          await engine.shutdown();
        }
        }, legacyDeliveryAgents(w));
      }


    });
  });

  it("stops when GitHub has a different pull request from the task's branch", async () => {
    await world("unexpected", async fixture => {
      const w = fixture.world;

      await fixture.engine(async engine => {

      try {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        engine.setProductDelivery(productId, "pull-request", false);
        const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        w.setGitHub((github) =>
          github.prs.push({ number: 7, url: "https://github.com/acme/demo/pull/7", headRefName: branchName("Add a greeting", taskId), baseRefName: "main", headRefOid: "f".repeat(40), state: "CLOSED", isCrossRepository: false, title: "Old", body: "" }),
        );
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("failed");
        expect(task.error).toContain("GitHub already has pull request #7 from this task's branch, but it is not this work");
        expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();
        expect(w.github().prs).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      }, legacyDeliveryAgents(w));
    });
  });

  it("confirms delivery when newer commits on GitHub follow the checked work", async () => {
    await world("verify", async fixture => {
      const w = fixture.world;

      await startHeld(fixture, "pull-request", "pr create", async ({ engine, taskId, hold }) => {

      try {
        // Someone pushes onto the branch while the pull request is being opened.
        const branch = taskOf(engine.getState(), taskId).branch!;
        const at = (await remoteRef(w.remote, `refs/heads/${branch}`))!;
        const env = testGitEnv({ ...process.env, GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: "s@example.com", GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: "s@example.com" });
        const other = await gitWith({ env }, "--git-dir", w.remote, "commit-tree", `${at}^{tree}`, "-p", at, "-m", "Someone else's change");
        await gitWith({}, "--git-dir", w.remote, "update-ref", `refs/heads/${branch}`, other);
        rmSync(hold);
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("pr-open");
        expect(task.error).toBeUndefined();
        expect(task.pr?.number).toBe(w.github().prs[0]!.number);
        expect(await remoteRef(w.remote, `refs/heads/${branch}`)).toBe(other);
        expect(w.github().calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
      } finally {
        await engine.shutdown();
      }


      });
    });
  });

  it("stops rather than overwrite a task branch GitHub holds at other work", async () => {
    await world("branch-taken", async fixture => {
      const w = fixture.world;

      await fixture.engine(async engine => {

      try {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        engine.setProductDelivery(productId, "pull-request", false);
        const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        // Someone else's work is already on GitHub under this task's branch name.
        const env = testGitEnv({ ...process.env, GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: "s@example.com", GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: "s@example.com" });
        const other = await gitWith({ env }, "--git-dir", w.remote, "commit-tree", `${w.initial}^{tree}`, "-p", w.initial, "-m", "Someone else's work");
        await gitWith({}, "--git-dir", w.remote, "update-ref", `refs/heads/${branchName("Add a greeting", taskId)}`, other);
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("failed");
        expect(task.error).toContain(`GitHub has this task's branch at ${other.slice(0, 7)}, which is not this work, so Petrina pushed nothing`);
        expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBe(other);
        expect(w.github().prs).toEqual([]);
      } finally {
        await engine.shutdown();
      }


      }, legacyDeliveryAgents(w));
    });
  });
});
