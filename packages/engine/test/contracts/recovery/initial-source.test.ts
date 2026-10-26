import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId, DeliveryMode } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { git } from "../../support.js";
import type { Engine } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";

const fixtures = nativeWorldFixtures();
afterAll(() => fixtures.close());

/** A plan checkpoint before any product work, with only the next Builder admission observed. */
async function prepare(engine: Engine, world: NativeWorld, delivery: DeliveryMode, withCopy = false) {
  engine.schedule = () => {};
  const productId = await engine.addProduct(world.clone);
  const id = engine.addTask({ productId, title: "Wait before starting the build", delivery, backlog: true });
  const task = engine.task(id)!;
  task.startedAt = 10; task.state = "running"; task.stageIndex = -1;
  task.plan = { rationale: "Build the approved change", plannerProfileId: "sol-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }] };
  const scope = executionFor(task);
  scope.work.source = { ...await engine["sources"].resolve(task, { productId, delivery, startFrom: { kind: "default" } }), confirmed: true };
  engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach(tool => { tool.status = "ready"; });
  if (withCopy) await engine["driver"]["prepare"](scope, new AbortController().signal);
  engine.gate(task, "plan");
  const checkpoint = engine.s.inbox.find(item => item.taskId === id && item.kind === "plan")!;
  const required = engine.addTask({ productId, title: "Land the prerequisite", backlog: true });
  const held = () => {
    engine.setRuntimeWait(id, [required], "The Builder needs the landed fix", "hold");
    engine.setRuntimeWait(id, [], "The prerequisite was resolved", "clear");
  };
  const admitted: string[] = [];
  engine["work"].runDo = async scope => { admitted.push(await git(scope.work.worktree!, "rev-parse", "HEAD")); return "stop"; };
  const run = async () => {
    await engine.approve(checkpoint.id);
    engine["driver"].startDriver(id);
    await engine.settling.get(id);
  };
  return { engine, world, task, scope, admitted, held, run };
}

function fixture<T>(delivery: DeliveryMode, withCopy: boolean, body: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<T>): Promise<T> {
  return fixtures.world("wait-initial-copy", ({ world, engine: withEngine }) => withEngine(async engine =>
    body(await prepare(engine, world, delivery, withCopy)), { agentCommand: () => undefined }));
}

const advanceRemote = async (world: NativeWorld) => {
  writeFileSync(join(world.clone, "required-fix.txt"), "The prerequisite's landed change\n");
  await git(world.clone, "add", "required-fix.txt"); await git(world.clone, "commit", "-qm", "Land the prerequisite fix");
  await git(world.clone, "push", "-q", world.remote, "main");
  const latest = await git(world.clone, "rev-parse", "HEAD");
  await git(world.clone, "reset", "--hard", world.initial);
  return latest;
};

describe.concurrent("a prerequisite wait before the first working copy", () => {
  for (const withCopy of [false, true]) it(`refreshes the commit-delivery source before the Builder starts (copy exists: ${withCopy})`, async () => {
    return fixture("local", withCopy, async f => {
      f.held(); const latest = await advanceRemote(f.world);
      const fetch = f.engine["connections"].fetchDefault.bind(f.engine["connections"]);
      let fetched = 0;
      f.engine["connections"].fetchDefault = async (...args) => { fetched += 1; return fetch(...args); };
      await f.run();
      expect(f.task.error).toBeUndefined();
      expect(f.admitted).toHaveLength(1);
      expect(f.scope.work.baseSha).toBe(latest);
      expect(await git(f.scope.work.worktree!, "show", "HEAD:required-fix.txt")).toBe("The prerequisite's landed change");
      expect(fetched).toBeGreaterThan(0);
      expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
    });
  });

  for (const withCopy of [false, true]) it(`stops when the GitHub source is unavailable before Builder admission (copy exists: ${withCopy})`, async () => {
    return fixture("pull-request", withCopy, async f => {
      f.held();
      f.engine["connections"].fetchDefault = async () => ({ ok: false, error: "The approved GitHub source is unavailable" });
      await f.run();
      expect(f.admitted).toEqual([]);
      expect(f.task.state).toBe("failed");
      expect(f.task.error).toContain("could not get the latest");
      expect(f.task.runtimeWait?.refreshPending).toBe(true);
    });
  });

  it("keeps ordinary no-wait commit preparation unchanged", async () => {
    return fixture("local", false, async f => {
      await advanceRemote(f.world);
      let fetched = 0;
      f.engine["connections"].fetchDefault = async () => { fetched += 1; return { ok: false, error: "Offline control" }; };
      await f.run();
      expect(f.task.error).toBeUndefined();
      expect(f.admitted).toEqual([f.world.initial]);
      expect(fetched).toBe(0);
      expect(f.task.runtimeWait).toBeUndefined();
    });
  });
});
