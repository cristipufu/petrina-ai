import { join } from "node:path";
import { completeAll, type Task } from "@petrina/core";
import type { Engine, EngineOptions } from "../engine.js";
import type { Scenario } from "../fake-agent.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers } from "./direct-drivers.js";
import { installPreparedProduct } from "./prepared-product.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";
import { Fakes, createProductRepository, tempDir, waitFor } from "../fixtures.js";
import { prepareUsageStage } from "./usage-prepared.js";
import { privateAgentToolProbe } from "../scripted-probes.js";

const configureUsageFastPaths = (engine: Engine) =>
  installSharedWorkflowFastPaths(engine, {
    skipUpToDate: true,
    skipPrepareChecks: true,
    skipReviewCopies: true,
    skipReviewInputDiffs: true,
    fastCheckCapture: true,
    fastCleanup: true,
  });

/** One task on fake agents, delivering locally, with every tool counted as installed. */
export type UsageWorldOptions = { description?: string; before?: (engine: Engine) => void; entry?: "design" | "builder" | "review"; stop?: "reviewed";
  sessions?: (fakes: Fakes) => NonNullable<EngineOptions["startAgentSession"]> };
async function prepareUsageWorld(root: string, lifetime: ReturnType<typeof directDrivers>, available: () => void, scenario: Scenario, options: UsageWorldOptions) {
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const sessions = options.sessions?.(fakes);
  const provider = sessions ? { startAgentSession: sessions, toolProbe: privateAgentToolProbe() } : {};
  const engine = configureUsageFastPaths(lifetime.open(join(root, "data"), { agentCommand: () => {
    if (sessions) throw new Error("This usage fixture requires its explicit scripted sessions");
    return [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir];
  }, toolPath: () => process.execPath, ...provider }));
  let current = engine;
  options.before?.(engine);
  const keepPaused = engine.s.pool.paused;
  if (options.entry) engine.setPoolPaused(true);
  available();
  const repository = await createProductRepository(root, { origin: "none" }), repo = repository.path;
  available();
  await engine.waitUntilReady();
  available();
  const productId = installPreparedProduct(engine, { id: "clone", name: "Clone", repo: "local/clone", tone: "blue", path: repo,
    remote: join(root, "origin.git"), defaultBranch: "main", delivery: "local", approveDelivery: true });
  engine.setProductDelivery(productId, "local", options.stop === "reviewed");
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: options.description ?? "[no-check]", ...(options.entry ? { backlog: true } : {}) });
  if (options.entry) {
    await prepareUsageStage(engine, root, taskId, scenario, options.entry, available, repository);
    available();
    engine.queueTask(taskId);
    if (!keepPaused) engine.setPoolPaused(false);
  }
  const find = (generation = current) => generation.getState().tasks.find((task) => task.id === taskId) as Task;
  // The coordinator answers whatever is asked on the way.
  const answer = (generation = current) => {
    for (const item of generation.getState().inbox) {
      if (item.taskId !== taskId) continue;
      if (item.kind === "plan" || item.kind === "design") generation.approve(item.id);
      else if (item.kind === "permission") generation.allow(item.id, "once");
      else if (item.kind === "question") generation.answer(item.id, item.options?.[0] ?? "Yes");
    }
  };
  const until = (reached: (task: Task, generation: Engine) => boolean, what: string) => {
    const generation = current;
    return lifetime.run(generation, () => waitFor(() => {
      const task = find(generation);
      if (task.state === "failed") throw new Error(`The task failed: ${task.error}`);
      if (reached(task, generation)) return task;
      answer(generation);
      return false;
    }, what, 60_000));
  };
  const completed = (roleId: string) => until((task, generation) => task.journey?.findLast(step => step.roleId === roleId)?.end === "done"
    && generation.tracking.log.turns({ taskId }).some(turn => turn.roleId === roleId && turn.end === "finished"), `the actual ${roleId} completion and its recorded turn`);
  const done = () => until((task, generation) => options.stop === "reviewed"
    ? generation.getState().inbox.some(item => item.taskId === taskId && item.kind === "delivery")
    : task.state === "done", options.stop === "reviewed" ? "the reviewed delivery decision" : "the task to finish");
  const modelOf = (session: string) => fakes.settings(session).find((line) => line.startsWith("model="))?.slice("model=".length);
  return { root, get engine() { return current; }, fakes, find, done, completed, until, answer, modelOf, taskId,
    run: <T>(start: () => Promise<T>) => { available(); return lifetime.run(current, start); },
    restart: (next: EngineOptions) => lifetime.prepare(async () => {
      available();
      await lifetime.stop(current);
      available();
      current = configureUsageFastPaths(lifetime.open(join(root, "data"), { ...provider, ...next }));
      return current;
    }),
  };
}

export type UsageWorld = Awaited<ReturnType<typeof prepareUsageWorld>>;

/** Whole cases and manual operations stay owned across independently stopped/reopened generations. */
export function usageWorlds() {
  const active = new Map<ReturnType<typeof directDrivers>, string>(), retained = new Set<string>();
  let closing = false;
  const closeOwner = (owner: ReturnType<typeof directDrivers>, root: string) => {
    const stopped = owner.close();
    void stopped.then(() => active.delete(owner), () => { active.delete(owner); retained.add(root); });
    return stopped;
  };
  async function use<T>(body: (fixture: UsageWorld) => Promise<T>, scenario: Scenario, options: UsageWorldOptions = {}): Promise<T> {
    if (closing) throw new Error("Usage fixtures are closing");
    const root = tempDir("petrina-usage-"), owner = directDrivers(root);
    active.set(owner, root);
    let closed = false;
    const close = () => { closed = true; return closeOwner(owner, root); };
    const available = () => { if (closed || closing) throw new Error("Usage fixture is closing"); };
    const value = await setupWithCleanup(() => owner.prepare(async () => {
      const fixture = await prepareUsageWorld(root, owner, available, scenario, options);
      available();
      return body(fixture);
    }), close);
    await close();
    return value;
  }
  async function close(): Promise<void> {
    closing = true;
    await completeAll([...active].map(([owner, root]) => closeOwner(owner, root)));
  }
  return { use, close, retained };
}
