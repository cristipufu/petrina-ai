import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Vote } from "@petrina/core";
import { Engine } from "../engine.js";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import type { Scenario } from "../fake-agent.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "../fixtures.js";
import { scriptedToolProbe } from "../scripted-probes.js";

export function independentReviewFixtures() {
const roots: string[] = [];
async function fixture(scenario: Scenario, limit = 3, reviewers?: string[], builderProfile?: string, reviewOnly = true, antigravity = false) {
  const root = tempDir("petrina-independence-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", ...scenario });
  const options = { agentCommand: (profile: { toolId: string }) => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, ...(!antigravity && profile.toolId === "antigravity" ? ["--logged-out"] : [])], toolPath: () => process.execPath, usageCommands: { codex: null },
    // These journeys test native seat handoffs, not login transport. The setup contract owns real probes.
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" },
      antigravity: { status: antigravity ? "ready" : "logged-out" }, gh: { status: "unknown" }, git: { status: "ready" }, node: { status: "ready" } }),
  };
  let engine = new Engine(join(root, "data"), options);
  return setupWithCleanup(async () => {
    engine.setPoolPaused(true);
    await engine.checkTools();
    engine.setPoolLimit(limit);
    for (const tool of Object.keys(ADAPTERS)) engine.setToolCap(tool, 1);
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    if (reviewOnly) {
      const product = engine.s.products.find((entry) => entry.id === productId)!;
      product.checks = [];
      product.checksBy = "coordinator";
    }
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", approvePlan: true });
    const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
    const model = (session: string) => fakes.settings(session).find((setting) => setting.startsWith("model="))?.slice(6);
    const models = (role: string) => [...new Set(fakes.received(role).map((entry) => entry.session))].map(model);
    const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
    const advance = (done: () => boolean, allow: (role: string, session: string) => boolean = () => true) => waitFor(() => {
      for (const prompt of fakes.received()) if (allow(prompt.role, prompt.session)) release(prompt.session);
      for (const item of engine.getState().inbox) {
        if (item.kind === "plan") {
          // Cases asserting design or brief preservation keep their design stages; code-review cases need neither.
          if (reviewOnly) {
            const planned = engine.s.tasks.find((entry) => entry.id === taskId)!.plan!;
            planned.stages = planned.stages.filter((stage) => stage.kind !== "converge");
          }
          const stage = task().plan!.stages.find((stage) => stage.kind === "review-chain")!;
          reviewers?.forEach((profile, index) => engine.setStageProfile(taskId, stage.id, "profileIds", index, profile));
          const build = task().plan!.stages.find((stage) => stage.roleId === "builder")!;
          if (builderProfile) engine.setStageProfile(taskId, build.id, "profileIds", 0, builderProfile);
          engine.approve(item.id);
        } else if (item.kind === "design") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      }
      if (task().state === "failed") throw new Error(task().error);
      return done();
    }, "the independent reviews", 60_000);
    const delivery = () => engine.getState().inbox.some((item) => item.kind === "delivery");
    const restart = async () => { await engine.shutdown(); engine = new Engine(join(root, "data"), options); };
    engine.setPoolPaused(false);
    return { get engine() { return engine; }, fakes, task, model, models, release, advance, delivery, restart, repo };
  }, () => engine.shutdown());
}
async function voting(scenario: Scenario = {}, limit = 3, limited = ["claude-code"], antigravity = false) {
  const f = await fixture({ controlled: true, reviewer: "important", ...scenario }, limit, undefined, undefined, true, antigravity);
  try {
    await f.advance(() => f.fakes.received("code reviewer").length >= (limit > 1 ? 2 : 1), (role) => role !== "code reviewer");
    f.engine.s.pool.limited = limited.map((toolId) => ({ toolId, until: Date.now() + 3_600_000, reason: `${toolId}'s usage limit` }));
    return f;
  } catch (error) { await f.engine.shutdown(); throw error; }
}
const checkedFinding = (f: Awaited<ReturnType<typeof voting>>) => f.task().findings.find((finding) => finding.text === "The greeting is missing on the welcome page.")!;
const plain = (votes?: readonly Vote[]) => votes?.map(({ ballot: _ballot, ...vote }) => vote);
const verifierSteps = (f: Awaited<ReturnType<typeof voting>>) => f.task().journey!.filter((step) => step.roleId === "verifier");
const inject = (f: Awaited<ReturnType<typeof voting>>, id: string, raisedBy: string, text = "The second greeting is missing.") =>
  f.engine.s.tasks.find((entry) => entry.id === f.task().id)!.findings.push({ id, text, severity: "blocking", raisedBy, confirmedBy: [], status: "open", evidence: "Opened the second page" });
async function close() { return roots.forEach(removeDir); }
return { fixture, voting, checkedFinding, plain, verifierSteps, inject, close };
}
