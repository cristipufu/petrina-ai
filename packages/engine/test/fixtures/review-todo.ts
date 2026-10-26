import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, type State, type Task } from "@petrina/core";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { engineProcesses, type EngineProcess, type EngineProcesses, Fakes, tempDir, makeProduct, waitFor } from "../support.js";

export function reviewProgressFixtures() {
  const lifetimes = new Set<EngineProcesses>();
  const MINUTE = 60_000;
  const models = ["opus-high", "gpt-6.1-sol-high"];
  function hasReadAction(task: Task, seat?: string): boolean {
    const agent = seat === undefined ? task.agent : [task.agent, ...(task.helpers ?? [])].find(agent => agent?.reviewKey === seat);
    const activity = seat === undefined ? task.toolActivity : task.hunt?.work?.[seat]?.toolActivity;
    return agent !== undefined && activity?.profileId === agent.profileId && activity.lastActivity === "Reading the code" && !activity.runningTool;
  }
  const reviewersHaveRead = (task: Task) => ["reviewer:0", "reviewer:1"].every(seat => hasReadAction(task, seat));
  async function setup(role: "code-reviewer" | "security-reviewer" = "code-reviewer", important = false) {
    const root = tempDir("petrina-group-summary-");
    const owners = engineProcesses(root); lifetimes.add(owners);
    const use = async <T>(body: () => Promise<T>): Promise<T> => {
      const value = await setupWithCleanup(() => owners.prepare(body), () => owners.close());
      await owners.close(); lifetimes.delete(owners); return value;
    };
    return setupWithCleanup(() => owners.prepare(async () => {
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true, ...(role === "security-reviewer" ? { risk: "high" } : {}), ...(important ? { reviewer: "important" } : {}) });
      const home = join(root, "home");
      const clock = join(root, "clock"); writeFileSync(clock, "0");
      let current: EngineProcess | undefined;
      const launch = async () => {
        if (current) await owners.stop(current);
        const engine = await owners.harness(home, fakes.dir, undefined, { entry: join(import.meta.dir, "../clock-harness.ts"), extra: [clock] });
        current = engine;
        return setupWithCleanup(async () => {
          await owners.run(engine, async () => engine.until(state => Object.keys(ADAPTERS).every(id => state.tools.some(tool => tool.id === id && tool.status === "ready") && state.setup?.checks.some(check => check.id === id && check.status === "ready" && !check.checking)), "every review tool to be ready"));
          return engine;
        }, async () => { await engine.quit(); });
      };
      const engine = await launch();
      return setupWithCleanup(async () => {
        await owners.run(engine, async () => engine.act("setPoolLimit", Object.keys(ADAPTERS).length));
        const productId = await owners.run(engine, async () => engine.act("addProduct", await makeProduct(root)));
        await owners.run(engine, async () => engine.act("setProductDelivery", productId, "local", true));
        const taskId = await owners.run(engine, async () => engine.act("addTask", { productId, title: "Check the greeting", approvePlan: true }));
        const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
        const planned = await owners.run(engine, async () => engine.until((state) => state.inbox.some((item) => item.kind === "plan"), "the plan check"));
        const stage = find(planned).plan!.stages.find((entry) => entry.roleId === role && entry.kind === "review-chain")!;
        await owners.run(engine, async () => engine.act("addReviewer", taskId, stage.id, role === "security-reviewer" ? "opus-high" : "sol-high"));
        const go = (name: string) => writeFileSync(join(fakes.dir, name), "go");
        // The security case first passes the single code reviewer.
        if (role === "security-reviewer") for (const name of ["publish-1", "action-1", "result-1", "finish"]) go(`${name}-code-reviewer-opus-high`);
        const approve = () => owners.run(engine, async () => engine.act("approve", planned.inbox.find((item) => item.kind === "plan")!.id));
        const ready = (tag: string, attempt = 1) => {
          const engine = current!;
          return owners.run(engine, () => waitFor(() => fakes.marked(`summary-ready-${tag}-${attempt}`), `${tag} to start attempt ${attempt}`, undefined, { during: engine.proc.exited }));
        };
        const advance = (minutes: number) => writeFileSync(clock, String(minutes * MINUTE));
        return { engine, owners, use, fakes, home, launch, find, taskId, role, stage, go, approve, ready, advance };
      }, async () => { await engine.quit(); });
    }), () => owners.close());
  }
  async function close() { await completeAll([...lifetimes].map(owners => owners.close())); }
  return { MINUTE, models, hasReadAction, reviewersHaveRead, setup, close };
}
