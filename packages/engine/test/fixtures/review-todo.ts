import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type State, type Task } from "@petrina/core";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { EngineProcess, Fakes, removeDir, tempDir, makeProduct, waitFor } from "../support.js";

export function reviewProgressFixtures() {
const roots: string[] = [];
const MINUTE = 60_000;
const models = ["opus-high", "gpt-6.1-sol-high"];
function hasReadAction(task: Task, seat?: string): boolean {
  const agent = seat === undefined ? task.agent : [task.agent, ...(task.helpers ?? [])].find(agent => agent?.reviewKey === seat);
  const activity = seat === undefined ? task.toolActivity : task.hunt?.work?.[seat]?.toolActivity;
  return agent !== undefined && activity?.profileId === agent.profileId && activity.lastActivity === "Reading the code" && !activity.runningTool;
}
const reviewersHaveRead = (task: Task) => ["reviewer:0", "reviewer:1"].every(seat => hasReadAction(task, seat));
async function setup(role: "code-reviewer" | "security-reviewer" = "code-reviewer", important = false) {
  const root = tempDir("petrina-group-summary-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true, ...(role === "security-reviewer" ? { risk: "high" } : {}), ...(important ? { reviewer: "important" } : {}) });
  const home = join(root, "home");
  const clock = join(root, "clock"); writeFileSync(clock, "0");
  const launch = async () => {
    const engine = await EngineProcess.start(home, [join(import.meta.dir, "../clock-harness.ts"), home, fakes.dir, clock]);
    return setupWithCleanup(async () => {
      await engine.until(state => Object.keys(ADAPTERS).every(id => state.tools.some(tool => tool.id === id && tool.status === "ready") && state.setup?.checks.some(check => check.id === id && check.status === "ready" && !check.checking)), "every review tool to be ready");
      return engine;
    }, async () => { await engine.quit(); });
  };
  const engine = await launch();
  return setupWithCleanup(async () => {
    await engine.act("setPoolLimit", Object.keys(ADAPTERS).length);
    const productId = await engine.act("addProduct", await makeProduct(root));
    await engine.act("setProductDelivery", productId, "local", true);
    const taskId = await engine.act("addTask", { productId, title: "Check the greeting", approvePlan: true });
    const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
    const planned = await engine.until((state) => state.inbox.some((item) => item.kind === "plan"), "the plan check");
    const stage = find(planned).plan!.stages.find((entry) => entry.roleId === role && entry.kind === "review-chain")!;
    await engine.act("addReviewer", taskId, stage.id, role === "security-reviewer" ? "opus-high" : "sol-high");
    const go = (name: string) => writeFileSync(join(fakes.dir, name), "go");
    // The security case first passes the single code reviewer.
    if (role === "security-reviewer") for (const name of ["publish-1", "action-1", "result-1", "finish"]) go(`${name}-code-reviewer-opus-high`);
    const approve = () => engine.act("approve", planned.inbox.find((item) => item.kind === "plan")!.id);
    const ready = (tag: string, attempt = 1) => waitFor(() => fakes.marked(`summary-ready-${tag}-${attempt}`), `${tag} to start attempt ${attempt}`);
    const advance = (minutes: number) => writeFileSync(clock, String(minutes * MINUTE));
    return { engine, fakes, home, launch, find, taskId, role, stage, go, approve, ready, advance };
  }, async () => { await engine.quit(); });
}
async function close() { return roots.forEach(removeDir); }
return { MINUTE, models, hasReadAction, reviewersHaveRead, setup, close };
}
