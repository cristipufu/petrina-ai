import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePlan, ROLE_STARTS, type DeepMutable, type PlanDraft, type Task } from "@petrina/core";
import { scopesFor } from "@petrina/orchestrator";
import { SLOW } from "@petrina/test-support/slow";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { Engine, type EngineOptions } from "../engine.js";
import { Fakes, git, makeProduct, tempDir, testBrowserRoot, waitFor } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import { directDrivers, closeDirectDrivers, removeFixtureRoot } from "./direct-drivers.js";
import { installPreparedProduct } from "./prepared-product.js";

const originalLines = Array.from({ length: 60 }, (_, index) => `Original line ${index}\n`).join("");
type StageInput = {
  prefix: string; title: string; description: string; scenario: Scenario;
  plan(engine: Engine): PlanDraft;
  start: "review" | "first";
  browser?: boolean; shared?: boolean; limit?: number; initialChange?: boolean;
  baseFiles?: Readonly<Record<string, string>>; changeFiles?: Readonly<Record<string, string>>;
  brief?: DeepMutable<NonNullable<Task["brief"]>>;
  native?(root: string, fakes: Fakes): EngineOptions;
  checks?(root: string): DeepMutable<NonNullable<import("@petrina/core").Product["checks"]>>;
};

const build = { kind: "do" as const, title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] };
const review = { kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };

/** Native target-stage fixtures. Plans/reports are declared inputs, never claims of an earlier execution. */
export function contextStageFixtures() {
  const lifetimes = new Set<ReturnType<typeof directDrivers>>();
  async function open(input: StageInput) {
    const root = tempDir(input.prefix);
    let browsers: string | undefined;
    const owner = directDrivers(root, { beforeRemoveRoot: () => { if (browsers) removeFixtureRoot(browsers); } });
    lifetimes.add(owner);
    const close = async () => { await owner.close(); lifetimes.delete(owner); };
    return setupWithCleanup(() => owner.prepare(async () => {
      if (input.browser) { browsers = testBrowserRoot(); registerFixtureRoot(browsers); }
      const fakes = new Fakes(join(root, "fake")); fakes.scenario(input.scenario);
      const native = input.native?.(root, fakes) ?? {};
      const options: EngineOptions = { agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir],
        toolPath: () => process.execPath, browser: input.browser ?? false, ...(browsers ? { browserTempRoot: browsers } : {}), ...native };
      const data = join(root, "data");
      let engine = owner.open(data, options);
      engine.setPoolPaused(true); await engine.waitUntilReady(); await engine.checkTools();
      engine.setPoolLimit(input.limit ?? 3);
      const products = [];
      for (const [id, name] of input.shared ? [["p", "Product"], ["second", "Second"]] : [["p", "Product"]]) {
        const folder = join(root, id!), repo = await makeProduct(folder, { origin: "none" });
        for (const [file, text] of Object.entries(input.baseFiles ?? {})) writeFileSync(join(repo, file), text);
        if (Object.keys(input.baseFiles ?? {}).length) { await git(repo, "add", "."); await git(repo, "commit", "-qm", "Prepare the context's starting code"); }
        installPreparedProduct(engine, { id: id!, name: name!, path: repo, repo: `local/${id}`, tone: "blue", defaultBranch: "main", delivery: "local", approveDelivery: true });
        const product = engine.s.products.find(product => product.id === id)!;
        // Check discovery is outside this context boundary. Empty declarations still go through
        // the real first-ever/no-command baseline; version-sensitive cases supply their real command.
        product.checks = structuredClone(input.checks?.(root) ?? []); product.checksBy = "coordinator";
        products.push(product);
      }
      if (input.shared) fakes.scenario({ ...input.scenario, affectedProducts: products.map(product => product.id) });
      const choices = products.map(product => ({ productId: product.id, startFrom: { kind: "default" as const }, delivery: "local" as const }));
      const id = engine.addTask({ productId: products[0]!.id, title: input.title, description: input.description, backlog: true,
        delivery: "local", approveDelivery: true, ...(input.shared ? { worksOn: choices } : {}) });
      let task = engine.task(id)!;
      task.risk = { level: input.scenario.risk ?? "medium", why: "Declared context-stage input" };
      const draft = input.plan(engine);
      // The clone is fresh fixture-owned input; its readonly rule output can be mutated by actual workflows.
      const plan = structuredClone(normalizePlan({ task: { ...task, source: undefined }, result: draft, roles: engine.s.roles,
        profiles: engine.s.profiles, plannerProfileId: "opus-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) })) as DeepMutable<NonNullable<Task["plan"]>>;
      task.plan = plan;
      const at = input.start === "review" ? plan.stages.findIndex(stage => stage.kind === "review-chain") : 0;
      if (at < 0) throw new Error("The declared context stage has no review");
      const works = [];
      for (const product of products) {
        const repo = product.path!, baseSha = await git(repo, "rev-parse", "HEAD"), path = join(root, `work-${product.id}`), branch = `context-${product.id}`;
        await git(repo, "worktree", "add", "-q", "-b", branch, path, baseSha);
        for (const [file, text] of Object.entries(input.changeFiles ?? {})) writeFileSync(join(path, file), text);
        if (input.initialChange) { await git(path, "add", "."); await git(path, "commit", "-qm", "Prepare the committed change supplied to review"); }
        works.push({ productId: product.id, worktree: path, branch, baseSha, base: "main", delivery: "local" as const,
          workChoice: choices.find(choice => choice.productId === product.id)!, workProduct: { ...product }, preparation: "ready" as const,
          // These preceding stages are the supplied boundary, not appended journey events.
          completedStages: plan.stages.slice(0, at).filter(stage => stage.kind === "do").map(stage => stage.id),
          source: { product: { ...product }, start: { kind: "default" as const, branch: "main" }, destination: { kind: "branch" as const, mode: "local" as const, repo: product.repo, branch: "main" }, initialSha: baseSha, confirmed: true },
          ...(input.initialChange ? { report: { summary: "Prepared initial greeting report", changes: ["People see a greeting"], tests: "Supplied stage input; no earlier Builder execution is claimed" } } : {}) });
      }
      if (input.shared) { delete task.repository; task.repositories = works; task.activeProductId = products[0]!.id; task.leadProductId = products[0]!.id; }
      else task.repository = works[0]!;
      if (input.brief) task.brief = structuredClone(input.brief);
      Object.assign(task, { state: "waiting", startedAt: Date.now(), stageIndex: at, sub: 0, approvePlan: false, statusLine: "Waiting to start the prepared context stage" });
      for (const scope of scopesFor(task)) await engine.rememberVersion(scope);
      engine.commitNow(task);
      const current = () => engine;
      const run = <T>(start: () => Promise<T>) => { const bound = engine; return owner.run(bound, start); };
      const restart = () => owner.prepare(async () => {
        const previous = engine;
        await owner.stop(previous);
        engine = owner.open(data, options);
        await engine.waitUntilReady();
        task = engine.task(id)!;
      });
      const use = <T>(body: () => Promise<T>) => owner.prepare(body);
      return { root, get browsers() { return browsers; }, fakes, options, products, task: () => task, engine: current,
        run, restart, use, start: () => engine.setPoolPaused(false), shutdown: () => owner.stop(engine), close };
    }), close);
  }

  async function reviewRun(reopen: Scenario["reopen"], input: { browser?: boolean; single?: boolean; shared?: boolean; limit?: number; limited?: Scenario["limited"]; reviewer?: Scenario["reviewer"]; advance?: boolean } = {}) {
    const f = await open({ prefix: "petrina-context-review-", title: "Reuse independent reviewers", description: "ORIGINAL-REVIEW-REQUEST [no-check]",
      scenario: { planner: input.single ? "short" : "pair", builder: "plain", reviewer: input.reviewer ?? "important", fixes: "change", controlled: true, reopen, limited: input.limited },
      plan: () => ({ rationale: "Declared input before the first real review", stages: [build, { ...review, profileIds: input.single ? ["opus-high"] : review.profileIds }] }),
      start: "review", initialChange: true, browser: input.browser, shared: input.shared, limit: input.limit ?? 2,
      baseFiles: input.advance ? { "REVIEW.md": "OLD-BASE-GUIDE\n", "overlap.txt": originalLines } : undefined,
      changeFiles: { "greeting.txt": "Hello\n", ...(input.advance ? { "overlap.txt": originalLines.replace("Original line 0\n", "Task changes the first line\n") } : {}) },
      brief: { summary: "ORIGINAL-DESIGN-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] },
      native: root => ({ agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), join(root, "fake"), `--script=${join(root, "script.json")}`] }),
      ...(input.advance ? { checks: (root: string) => [{ name: "Exact code", argv: [process.execPath, "-e", `import { git } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))}; console.log('CHECKED-CODE:' + await git(process.cwd(), 'rev-parse', 'HEAD')); if (require('node:fs').existsSync(${JSON.stringify(join(root, "fail-check"))})) process.exit(1);`], why: "Prove checks run on the current code" }] } : {}),
    });
    return setupWithCleanup(() => f.use(async () => {
      const hold = join(f.root, "hold-fixes");
      if (input.advance) { writeFileSync(hold, ""); writeFixtureJson(join(f.root, "script.json"), { hold: { title: "You are fixing the review findings", file: hold } }); }
      const released = new Set<string>();
      const tick = (allow: (role: string, session: string) => boolean = () => true) => {
        for (const entry of f.fakes.received()) if (allow(entry.role, entry.session) && !released.has(entry.session)) {
          writeFileSync(join(f.fakes.dir, `release-${entry.session}`), "go"); released.add(entry.session);
        }
        for (const item of f.engine().getState().inbox) {
          if (item.kind === "question") f.engine().answer(item.id, "Yes");
          else if (item.kind === "permission") f.engine().allow(item.id, "once");
        }
        if (f.task().state === "failed") throw new Error(f.task().error);
      };
      const beforeFix = () => f.run(() => waitFor(() => { tick(); return existsSync(`${hold}.reached`); }, "the controlled Builder fix"));
      const done = () => f.run(() => { rmSync(hold, { force: true }); return waitFor(() => { tick(); return f.engine().getState().inbox.some(item => item.kind === "delivery") && f.task(); }, "the reviewed delivery"); });
      const advanceMain = (id = f.products.at(-1)!.id, conflict = false) => f.run(async () => {
        const product = f.engine().s.products.find(product => product.id === id)!;
        const before = await git(product.path!, "rev-parse", "HEAD");
        writeFileSync(join(product.path!, "REVIEW.md"), "NEW-BASE-GUIDE\n");
        writeFileSync(join(product.path!, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
        if (conflict) writeFileSync(join(product.path!, "greeting.txt"), "Main's incompatible greeting\n");
        await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Advance main independently");
        return { productId: id, before, base: await git(product.path!, "rev-parse", "HEAD") };
      });
      f.start();
      return { ...f, browsers: f.browsers!, hold, tick, done, beforeFix, advanceMain };
    }), f.close);
  }

  async function designRun(reopen: Scenario["reopen"], limited?: Scenario["limited"], standIn?: "author" | "reviewer") {
    const f = await open({ prefix: "petrina-context-design-", title: "Agree on the greeting", description: "ORIGINAL-DESIGN-REQUEST: keep it welcoming.",
      scenario: { planner: "limits", builder: "plain", controlled: true, reviseBrief: true, reopen, limited }, start: "first",
      // Research is genuinely performed: the continuation must omit an earlier actual hand-back.
      plan: () => ({ rationale: "Declared design with its required earlier report", stages: [
        { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
        { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 }, build,
        { ...review, profileIds: ["opus-high", "opus-xhigh", "sol-high"] },
      ] }),
    });
    return setupWithCleanup(() => f.use(async () => {
      const tick = (holdReviewer = false) => {
        for (const entry of f.fakes.received()) if (entry.role !== "builder" && (!holdReviewer || entry.role !== "design reviewer")) writeFileSync(join(f.fakes.dir, `release-${entry.session}`), "go");
        for (const item of f.engine().getState().inbox) {
          if (item.taskId !== f.task().id) continue;
          if (item.kind === "plan" || item.kind === "design") f.engine().approve(item.id);
          else if (item.kind === "question") f.engine().answer(item.id, "Yes");
          else if (item.kind === "permission") f.engine().allow(item.id, "once");
        }
        if (f.task().state === "failed") throw new Error(f.task().error);
      };
      const done = () => f.run(() => waitFor(() => { tick(); return f.task().journey?.some(step => step.roleId === "design-reviewer" && step.round === 2 && step.endedAt) && f.task(); }, "both participants to finish their second design round"));
      if (standIn) f.engine().s.pool.limited = [{ toolId: standIn === "author" ? "claude-code" : "codex", until: Date.now() + 3_600_000, reason: "Controlled usage limit" }];
      f.start(); return { ...f, tick, done };
    }), f.close);
  }

  async function builderRun(scenario: Scenario = {}) {
    let nextGrokCheck: string | undefined;
    const f = await open({ prefix: "petrina-context-builder-", title: "Add a greeting", description: "[no-check]", start: "first",
      scenario: { planner: "claude-build", builder: "plain", controlled: true, reopen: "resume", limited: [{ model: "opus", role: "builder", spendCap: true }], ...scenario },
      plan: () => ({ rationale: "Declared Builder and subsequent review", stages: [{ ...build, profileIds: ["opus-high"] }, { ...review, profileIds: ["sol-high"], maxRounds: 1 }] }),
      native: (_root, fakes) => ({ agentCommand: profile => { const flag = profile.toolId === "grok" ? nextGrokCheck : undefined; if (flag) nextGrokCheck = undefined;
        return [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, ...(flag ? [flag] : [])]; }, toolCheckTimeoutMs: 8000 * SLOW }),
    });
    return setupWithCleanup(() => f.use(async () => {
      const model = (session: string) => f.fakes.settings(session).find(line => line.startsWith("model="))?.slice(6);
      const advance = (done: () => boolean, allow: (role: string) => boolean = () => true) => f.run(() => waitFor(() => {
        for (const prompt of f.fakes.received()) if (allow(prompt.role)) writeFileSync(join(f.fakes.dir, `release-${prompt.session}`), "go");
        for (const item of f.engine().getState().inbox) {
          if (["plan", "design"].includes(item.kind)) f.engine().approve(item.id);
          if (item.kind === "question") f.engine().answer(item.id, item.options?.[0] ?? "Yes");
          if (item.kind === "permission") f.engine().allow(item.id, "once");
        }
        if (f.task().state === "failed") throw new Error(f.task().error);
        return done();
      }, "the Builder and its reviews", 60_000));
      const restart = (flag?: string) => f.use(async () => {
        nextGrokCheck = flag; f.options.toolCheckTimeoutMs = (flag === "--hang" ? 200 : 8000) * SLOW;
        await f.restart();
      });
      return { ...f, get engine() { return f.engine(); }, task: () => f.engine().getState().tasks.find(task => task.id === f.task().id)!, model, advance,
        delivery: () => f.engine().getState().inbox.some(item => item.kind === "delivery"), restart, repo: f.products[0]!.path! };
    }), f.close);
  }

  async function evidence(scenario: Scenario) {
    const f = await open({ prefix: "petrina-context-evidence-", title: "Add a greeting", description: "[no-check]", scenario, start: "first",
      plan: engine => {
        const added = scenario.planner === "mixed-review" ? engine.addRole(ROLE_STARTS.find(role => role.id === "security")!.draft) : undefined;
        return { rationale: "Declared Builder and review correction input", ...(scenario.risk ? { risk: { level: scenario.risk } } : {}), stages: [build,
          { ...review, profileIds: scenario.planner === "short" ? ["opus-high"] : review.profileIds,
            ...(added ? { roleIds: ["code-reviewer", added] } : {}) }] };
      },
    });
    return setupWithCleanup(() => f.use(async () => {
      f.start();
      const task = await f.run(() => waitFor(() => {
        for (const item of f.engine().getState().inbox) {
          if (item.taskId !== f.task().id) continue;
          if (item.kind === "permission") f.engine().allow(item.id, "once");
          else if (item.kind === "question") f.engine().answer(item.id, item.options?.[0] ?? "Yes");
        }
        if (f.task().state === "failed") throw new Error(f.task().error);
        return f.engine().getState().inbox.some(item => item.taskId === f.task().id && item.kind === "delivery") && f.engine().taskDetails(f.task().id)!;
      }, "the delivery check", 60_000));
      await f.shutdown(); return { task, fakes: f.fakes };
    }), f.close);
  }

  async function messages(scenario: Scenario) {
    const f = await open({ prefix: "petrina-context-message-", title: "Add a greeting", description: "[no-check]", scenario, start: "review", initialChange: true,
      plan: () => ({ rationale: "Declared first parallel review", stages: [build, { ...review, maxRounds: 1 }] }), changeFiles: { "greeting.txt": "Hello\n" } });
    return setupWithCleanup(() => f.use(async () => { f.start(); return f; }), f.close);
  }

  const close = async () => { await closeDirectDrivers(lifetimes); lifetimes.clear(); };
  return { reviewRun, designRun, builderRun, evidence, messages, close };
}
