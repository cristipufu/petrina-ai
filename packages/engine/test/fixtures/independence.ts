import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Vote } from "@petrina/core";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import type { Scenario } from "../fake-agent.js";
import { Fakes, makeProduct, tempDir, waitFor } from "../fixtures.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import { sourcePlan } from "./source-agents.js";
import { sourcePrepared } from "./source-prepared.js";
import { installInitialUpdateBuild } from "./initial-update-build.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";

/** The existing provider recipe with the unrelated design prefix omitted, as the old plan callback did. */
function reviewPlan(scenario: Scenario) {
  if (scenario.planner !== undefined && scenario.planner !== "short" && scenario.planner !== "build-review")
    throw new Error("The independent review fixture needs its declared ordinary or short plan");
  const plan = sourcePlan({ ...scenario, planner: scenario.planner === "build-review" ? "short" : scenario.planner }, "[no-check]");
  plan.stages = plan.stages.filter(stage => stage.kind !== "converge" && !("gate" in stage && stage.gate === "design"));
  if (scenario.planner === "build-review") {
    plan.rationale = "Build it, then two reviewers.";
    const review = plan.stages.find(stage => stage.kind === "review-chain")!;
    Object.assign(review, { profileIds: ["opus-high", "sol-high"], maxRounds: 1 });
  }
  return plan;
}

export function independentReviewFixtures() {
const owners = new Set<ReturnType<typeof directDrivers>>();
async function fixture(scenario: Scenario, limit = 3, reviewers?: string[], builderProfile?: string, reviewOnly = true, antigravity = false, acceptedBuild = false) {
  if (acceptedBuild && (!reviewOnly || scenario.builder !== undefined && scenario.builder !== "plain"))
    throw new Error("An accepted initial build requires the plain review-only fixture recipe");
  const root = tempDir("petrina-independence-");
  const lifetime = directDrivers(root); owners.add(lifetime);
  const close = async () => { try { await lifetime.close(); } finally { owners.delete(lifetime); } };
  return setupWithCleanup(() => lifetime.prepare(async () => {
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", ...scenario });
  const options = {
    agentCommand: (profile: { toolId: string }) => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, ...(!antigravity && profile.toolId === "antigravity" ? ["--logged-out"] : [])],
    startAgentSession: fakeAgentSessions(fakes, {
      flags: (toolId) => (!antigravity && toolId === "antigravity" ? ["--logged-out"] : []),
    }),
    toolPath: () => process.execPath,
    usageCommands: { codex: null },
    runCheckCommand: async (req: { argv: readonly string[] }) =>
      req.argv[0] === "git" && req.argv[1] === "--version" ? { code: 0, stdout: "git version 2.45.0\n" } : undefined,
    // These journeys test native seat handoffs, not login transport. The setup contract owns real probes.
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" },
      antigravity: { status: antigravity ? "ready" : "logged-out" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" }, gh: { status: "unknown" }, git: { status: "ready" } }),
  };
  const openEngine = () => {
    const next = lifetime.open(join(root, "data"), options);
    installSharedWorkflowFastPaths(next, {
      skipUpToDate: true,
      skipPrepareChecks: true,
      skipReviewCopies: true,
      skipReviewInputDiffs: true,
      fastCheckCapture: true,
      fastCleanup: true,
    });
    return next;
  };
  let engine = openEngine();
    const available = () => engine.stopRequested.signal.throwIfAborted();
    engine.setPoolPaused(true);
    await engine.waitUntilReady(); available();
    await engine.checkTools();
    available();
    engine.setPoolLimit(limit);
    for (const tool of Object.keys(ADAPTERS)) engine.setToolCap(tool, 1);
    const repo = await makeProduct(root);
    available();
    const productId = installPreparedProduct(engine, privateCloneProduct(repo));
    engine.setProductDelivery(productId, "local", true);
    if (reviewOnly) {
      const product = engine.s.products.find((entry) => entry.id === productId)!;
      product.checks = [];
      product.checksBy = "coordinator";
    }
    const input = { productId, title: "Add a greeting", description: "[no-check]", approvePlan: true };
    const taskId = reviewOnly ? await sourcePrepared(engine, input, reviewPlan(scenario), { kind: "builder",
      brief: { summary: "", forUsers: [], areas: [], acceptance: [], risks: [] },
      beforeAdmission: id => {
        const prepared = engine.task(id)!, at = prepared.stageIndex;
        // These coordinator assignments precede the accepted starting stage, just as at the old plan gate.
        prepared.stageIndex = -1;
        try {
          const review = prepared.plan!.stages.find(stage => stage.kind === "review-chain")!;
          reviewers?.forEach((profile, index) => engine.setStageProfile(id, review.id, "profileIds", index, profile));
          const build = prepared.plan!.stages.find(stage => engine.role(stage.roleId, prepared)?.result === "build")!;
          if (builderProfile) engine.setStageProfile(id, build.id, "profileIds", 0, builderProfile);
        } finally { prepared.stageIndex = at; }
        if (acceptedBuild) installInitialUpdateBuild(engine, id, {
          async beforeBuild() {},
          async acceptedInitialBuild(path, signal) {
            available(); signal.throwIfAborted();
            writeFileSync(join(path, "greeting.txt"), "Hello (with left-pad)\n");
            return { summary: "Added a greeting.", changes: ["People see a greeting"] };
          },
        }, available);
      },
    }, available) : engine.addTask(input);
    const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
    const model = (session: string) => fakes.settings(session).find((setting) => setting.startsWith("model="))?.slice(6);
    const models = (role: string) => [...new Set(fakes.received(role).map((entry) => entry.session))].map(model);
    const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
    const advance = (done: () => boolean, allow: (role: string, session: string) => boolean = () => true) => lifetime.prepare(() => waitFor(() => {
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
    }, "the independent reviews", 60_000));
    const delivery = () => engine.getState().inbox.some((item) => item.kind === "delivery");
    const restart = () => lifetime.prepare(async () => { await lifetime.stop(engine); engine = openEngine(); });
    engine.setPoolPaused(false);
    return { get engine() { return engine; }, fakes, task, model, models, release, advance, delivery, restart, repo, close,
      run: <T>(body: () => Promise<T>) => lifetime.prepare(body) };
  }), close);
}
async function voting(scenario: Scenario = {}, limit = 3, limited = ["claude-code"], antigravity = false, start?: { acceptedBuild: true }) {
  const f = await fixture({ controlled: true, reviewer: "important", ...scenario }, limit, undefined, undefined, true, antigravity, start?.acceptedBuild);
  return setupWithCleanup(() => f.run(async () => {
    await f.advance(() => f.fakes.received("code reviewer").length >= (limit > 1 ? 2 : 1), (role) => role !== "code reviewer");
    f.engine.s.pool.limited = limited.map((toolId) => ({ toolId, until: Date.now() + 3_600_000, reason: `${toolId}'s usage limit` }));
    return f;
  }), f.close);
}
const checkedFinding = (f: Awaited<ReturnType<typeof voting>>) => f.task().findings.find((finding) => finding.text === "The greeting is missing on the welcome page.")!;
const plain = (votes?: readonly Vote[]) => votes?.map(({ ballot: _ballot, ...vote }) => vote);
const verifierSteps = (f: Awaited<ReturnType<typeof voting>>) => f.task().journey!.filter((step) => step.roleId === "verifier");
const inject = (f: Awaited<ReturnType<typeof voting>>, id: string, raisedBy: string, text = "The second greeting is missing.") =>
  f.engine.s.tasks.find((entry) => entry.id === f.task().id)!.findings.push({ id, text, severity: "blocking", raisedBy, confirmedBy: [], status: "open", evidence: "Opened the second page" });
async function close() { return closeDirectDrivers(owners); }
return { fixture, voting, checkedFinding, plain, verifierSteps, inject, close };
}
