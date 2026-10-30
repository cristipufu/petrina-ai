import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePlan, type DeepMutable, type Finding, type PlanDraft, type Role, type Task } from "@petrina/core";
import { ReopenFailed, scopesFor, type AgentSession, type AgentSessionOptions } from "@petrina/orchestrator";
import { limitFromFailure, limitFromReport, type UsageInfo } from "@petrina/agent-runtime/usage";
import * as gitOps from "@petrina/repositories/git";
import { headNow } from "@petrina/test-support/repository-head";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { Engine, type EngineOptions } from "../engine.js";
import { Fakes, createProductRepository, tempDir, testBrowserRoot, waitFor } from "../fixtures.js";
import type { AgentScript, Scenario } from "../fake-agent.js";
import { recordPrompt } from "../prompt-records.js";
import { answersTo, findingIds } from "../scripted-findings.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { directDrivers, closeDirectDrivers, removeFixtureRoot } from "./direct-drivers.js";
import { installPreparedProduct } from "./prepared-product.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";

const originalLines = Array.from({ length: 60 }, (_, index) => `Original line ${index}\n`).join("");
const earlier: DeepMutable<Finding> = {
  id: "older",
  text: "An earlier bug",
  severity: "blocking",
  raisedBy: "sol-high",
  confirmedBy: [],
  status: "fixed",
  answer: { fixed: true, text: "Fixed the earlier bug", at: 1 },
};

const build = { kind: "do" as const, title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] };
const review = { kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };

interface SavedConversation {
  cwd: string;
  role: string;
  model: string;
  effort: string;
  turns: number;
  restarts: number;
}

interface AdvanceSeed {
  readonly objects: string;
  readonly index: string;
  readonly head: string;
}

interface PreparedSeed {
  readonly repo: string;
  readonly worktree: string;
  readonly baseSha: string;
  readonly changeSha: string;
  readonly changeTree: string;
  readonly advanceClean?: AdvanceSeed;
  readonly advanceConflict?: AdvanceSeed;
}

function roleOf(text: string): string {
  return /You are the ([A-Za-z -]+) in Petrina/.exec(text)?.[1]?.trim().toLowerCase() ?? "";
}

function doneBlock(plan: Scenario, value: Record<string, unknown>, prose = "Done."): string {
  const ids = plan.affectedProducts;
  const copy: Record<string, unknown> = { ...value };
  if (ids && Array.isArray(copy.findings)) {
    copy.findings = (copy.findings as Record<string, unknown>[]).map(finding => ({ ...finding, productIds: ids }));
  }
  return `${prose}\n\n\`\`\`petrina\n${JSON.stringify(copy)}\n\`\`\``;
}

function outOfUsage(dir: string, limit: NonNullable<Scenario["limited"]>[number]): number | undefined {
  const file = join(dir, `limit-${limit.model}`);
  if (!existsSync(file)) writeFileSync(file, String(Date.now() + (limit.resetsInMs ?? 3_600_000)));
  const until = Number(readFileSync(file, "utf8"));
  return Date.now() < until ? until : undefined;
}

const headCheckScript = (failPath: string) => [
  'const fs = require("node:fs"), p = require("node:path");',
  'const dot = p.join(process.cwd(), ".git");',
  'const gitdir = fs.statSync(dot).isDirectory() ? dot : p.resolve(process.cwd(), fs.readFileSync(dot, "utf8").replace(/^gitdir:\\s*/, "").trim());',
  'const commondir = fs.existsSync(p.join(gitdir, "commondir")) ? p.resolve(gitdir, fs.readFileSync(p.join(gitdir, "commondir"), "utf8").trim()) : gitdir;',
  'const head = fs.readFileSync(p.join(gitdir, "HEAD"), "utf8").trim();',
  'const sha = head.startsWith("ref: ") ? fs.readFileSync(p.join(commondir, head.slice(5)), "utf8").trim() : head;',
  'console.log("CHECKED-CODE:" + sha);',
  `if (fs.existsSync(${JSON.stringify(failPath)})) process.exit(1);`,
].join(" ");

export interface ReviewerStageInput {
  browser?: boolean;
  single?: boolean;
  shared?: boolean;
  limit?: number;
  limited?: Scenario["limited"];
  reviewer?: Scenario["reviewer"];
  advance?: boolean;
  checks?: boolean;
  settledHistory?: boolean;
  inspectDiffs?: boolean;
}

export function reviewerConversationStageFixtures() {
  const lifetimes = new Set<ReturnType<typeof directDrivers>>();
  const seeds = new Map<boolean, Promise<PreparedSeed>>();
  let seedRoot: string | undefined;

  function getSeed(advance: boolean): Promise<PreparedSeed> {
    const existing = seeds.get(advance);
    if (existing) return existing;
    const preparing = (async (): Promise<PreparedSeed> => {
      seedRoot ??= tempDir("petrina-reviewer-seed-");
      const folder = join(seedRoot, advance ? "advance" : "basic");
      const { path: repo, initialSha } = await createProductRepository(folder, { origin: "none" });
      if (advance) {
        writeFileSync(join(repo, "REVIEW.md"), "OLD-BASE-GUIDE\n");
        writeFileSync(join(repo, "overlap.txt"), originalLines);
        await gitOps.commitChanges(repo, "Prepare the context's starting code");
      }
      const baseSha = advance ? readFileSync(join(repo, ".git", "refs", "heads", "main"), "utf8").trim() : initialSha;
      const worktree = join(folder, "work");
      await gitOps.ensureWorktree(repo, worktree, "seed-context", baseSha);
      writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
      if (advance) writeFileSync(join(worktree, "overlap.txt"), originalLines.replace("Original line 0\n", "Task changes the first line\n"));
      await gitOps.commitChanges(worktree, "Prepare the committed change supplied to review");
      const changeSha = readFileSync(join(repo, ".git", "refs", "heads", "seed-context"), "utf8").trim();
      const changeTree = (await gitOps.treeOf(worktree))!;
      let advanceClean: AdvanceSeed | undefined;
      let advanceConflict: AdvanceSeed | undefined;
      if (advance) {
        const cleanRepo = join(folder, "advance-clean");
        cpSync(repo, cleanRepo, { recursive: true });
        writeFileSync(join(cleanRepo, "REVIEW.md"), "NEW-BASE-GUIDE\n");
        writeFileSync(join(cleanRepo, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
        await gitOps.commitChanges(cleanRepo, "Advance main independently");
        advanceClean = {
          objects: join(cleanRepo, ".git", "objects"),
          index: join(cleanRepo, ".git", "index"),
          head: readFileSync(join(cleanRepo, ".git", "refs", "heads", "main"), "utf8").trim(),
        };
        const conflictRepo = join(folder, "advance-conflict");
        cpSync(repo, conflictRepo, { recursive: true });
        writeFileSync(join(conflictRepo, "REVIEW.md"), "NEW-BASE-GUIDE\n");
        writeFileSync(join(conflictRepo, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
        writeFileSync(join(conflictRepo, "greeting.txt"), "Main's incompatible greeting\n");
        await gitOps.commitChanges(conflictRepo, "Advance main independently");
        advanceConflict = {
          objects: join(conflictRepo, ".git", "objects"),
          index: join(conflictRepo, ".git", "index"),
          head: readFileSync(join(conflictRepo, ".git", "refs", "heads", "main"), "utf8").trim(),
        };
      }
      return Object.freeze({ repo, worktree, baseSha, changeSha, changeTree, advanceClean, advanceConflict });
    })();
    seeds.set(advance, preparing);
    return preparing;
  }

  function createSessionStarter(root: string, fakes: Fakes, getBrowsers: () => string | undefined, getEngine: () => Engine) {
    const scriptPath = join(root, "script.json");
    const readScenario = (): Scenario => (existsSync(join(fakes.dir, "scenario.json")) ? (JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario) : {});
    const readScript = (): AgentScript => (existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as AgentScript) : {});
    const conversationFile = (sessionId: string) => join(fakes.dir, "conversations", `${sessionId}.json`);
    const saveConversation = (sessionId: string, conversation: SavedConversation) => {
      const file = conversationFile(sessionId);
      mkdirSync(dirname(file), { recursive: true });
      writeFixtureJson(file, conversation);
    };
    const recordOpen = (sessionId: string, how: "new" | "resume" | "load") => {
      appendFileSync(join(fakes.dir, "opens.jsonl"), `${JSON.stringify({ session: sessionId, how, tool: "", background: true, logins: true, quiet: true })}\n`);
    };
    const recordConfig = (sessionId: string, value: string) => {
      appendFileSync(join(fakes.dir, "config.jsonl"), `${JSON.stringify({ session: sessionId, configId: "model", value })}\n`);
    };

    return async (options: AgentSessionOptions, role: Role): Promise<AgentSession> => {
      const gone = Promise.withResolvers<void>();
      options.onGone?.(gone.promise);
      if (options.signal.aborted) {
        gone.resolve();
        throw new Error("Stopped before the agent started");
      }
      const plan = readScenario();
      const modelValue = options.profile.modelId ?? options.profile.model;
      let sessionId: string;
      let reopened: "resume" | "load" | undefined;
      let conversation: SavedConversation;
      if (options.reopen !== undefined) {
        const how = plan.reopen;
        if (how !== "resume" && how !== "load") {
          gone.resolve();
          throw new ReopenFailed("The tool cannot reopen conversations");
        }
        const file = conversationFile(options.reopen);
        if (!existsSync(file)) {
          gone.resolve();
          throw new ReopenFailed("Could not reopen the conversation");
        }
        sessionId = options.reopen;
        reopened = how;
        conversation = JSON.parse(readFileSync(file, "utf8")) as SavedConversation;
        conversation.model = modelValue;
        conversation.effort = options.profile.effort;
        recordOpen(sessionId, how);
        recordConfig(sessionId, modelValue);
        saveConversation(sessionId, conversation);
      } else {
        sessionId = crypto.randomUUID();
        conversation = { cwd: options.cwd, role: "", model: modelValue, effort: options.profile.effort, turns: 0, restarts: 0 };
        saveConversation(sessionId, conversation);
        recordOpen(sessionId, "new");
        recordConfig(sessionId, modelValue);
      }

      const browsers = getBrowsers();
      const browser = options.browser && browsers ? { directory: join(browsers, `petrina-browser-${sessionId}`) } : undefined;
      const settings = { model: modelValue, modelName: options.profile.model, effort: options.profile.effort };
      const notes = { changed: {}, rerouted: false, helpers: 0 };
      let stopped = false;
      let cancelled = false;
      let wake: (() => void) | undefined;

      const close = () => {
        if (stopped) return;
        stopped = true;
        wake?.();
        gone.resolve();
      };
      const stop = async () => {
        close();
        return true;
      };
      options.signal.addEventListener("abort", close, { once: true });

      const waitWhile = async (predicate: () => boolean) => {
        while (!stopped && !cancelled && !options.signal.aborted && predicate()) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 15);
            wake = () => { clearTimeout(timer); resolve(); };
          });
        }
        wake = undefined;
        if (stopped || options.signal.aborted) throw new Error("The agent stopped (exit signal)");
      };

      const waitHeld = async (roleName: "builder" | "release manager" | "code reviewer", text: string) => {
        const hold = readScript().hold;
        if (!hold || (hold.role ?? "builder") !== roleName || !text.includes(hold.title) || !existsSync(hold.file)) return;
        writeFileSync(`${hold.file}.reached`, "");
        await waitWhile(() => existsSync(hold.file));
      };

      const failOutOfUsage = (limit: NonNullable<Scenario["limited"]>[number], until: number): never => {
        const said = "I drafted notes.txt and started on the greeting file before running out.";
        if (conversation.turns === 1) {
          writeFileSync(join(conversation.cwd, "notes.txt"), "A first draft\n");
          options.callbacks.onPlanStep("Drafting the greeting");
        }
        options.callbacks.onMessage?.({ id: 1, text: said });
        if (limit.spendCap) {
          const refusal = limitFromFailure(options.profile, { message: "Internal error", data: { errorKind: "billing_error" } }, said, Date.now())!;
          refusal.said = said;
          refusal.streamed = true;
          throw refusal;
        }
        const info: UsageInfo = {
          toolId: options.profile.toolId,
          status: "rejected",
          kind: (limit.type ?? "five_hour") as UsageInfo["kind"],
          utilization: 1,
          resetsAt: Math.ceil(until / 1000) * 1000,
        };
        getEngine().recordUsage(info);
        const refusal = limitFromReport(options.profile, info, Date.now(), "refusal");
        refusal.said = said;
        refusal.streamed = true;
        throw refusal;
      };

      return {
        sessionId,
        reopened,
        browser,
        liveInput: false,
        prompting: false,
        settings,
        lastTurn: notes,
        async guide() { return "unsupported"; },
        async prompt(text: string) {
          if (stopped || options.signal.aborted) throw new Error("The agent stopped (exit signal)");
          cancelled = false;
          conversation.turns += 1;
          const detected = roleOf(text);
          if (detected) conversation.role = detected;
          conversation.role ||= role.name.toLowerCase();
          if (text.includes("Petrina restarted")) conversation.restarts += 1;
          saveConversation(sessionId, conversation);
          await recordPrompt(fakes.dir, { role: conversation.role, session: sessionId, text });

          const currentPlan = readScenario();
          const limit = (currentPlan.limited ?? []).find(entry => entry.model === conversation.model && (!entry.role || entry.role === conversation.role));
          const until = limit && outOfUsage(fakes.dir, limit);
          if (limit && until && !limit.afterRelease) failOutOfUsage(limit, until);

          if (currentPlan.controlled && conversation.turns === 1) {
            options.callbacks.onPlanStep(`${conversation.role} is working`);
            await waitWhile(() => !existsSync(join(fakes.dir, `release-${sessionId}`)));
            if (cancelled) return { stopReason: "cancelled", text: "", ...notes };
          }
          if (limit?.afterRelease && until) failOutOfUsage(limit, until);

          const respond = (value: Record<string, unknown>) => {
            const replyText = doneBlock(currentPlan, value);
            options.callbacks.onMessage?.({ id: 1, text: replyText });
            return { stopReason: "end_turn" as const, text: replyText, streamed: true, ...notes };
          };

          switch (conversation.role) {
            case "builder": {
              options.callbacks.onPlanStep("Writing the greeting");
              writeFileSync(join(conversation.cwd, "greeting.txt"), "Hello\n");
              if (currentPlan.fixes === "change" && text.includes("You are fixing the review findings")) {
                writeFileSync(join(conversation.cwd, "welcome.txt"), `Hello ${Date.now()}\n`);
              }
              await waitHeld("builder", text);
              if (cancelled) return { stopReason: "cancelled", text: "", ...notes };
              const script = readScript();
              const title = script.title ?? currentPlan.title;
              const description = script.description ?? (text.includes('"description"') ? "Adds a greeting file.\n\nTested with the greeting test." : undefined);
              return respond({
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                summary: "Added a greeting.",
                changes: ["People see a greeting"],
                tests: "1 passed",
                answers: answersTo(text, currentPlan.answer),
              });
            }
            case "code reviewer": {
              await waitHeld("code reviewer", text);
              if (cancelled) return { stopReason: "cancelled", text: "", ...notes };
              if (
                (currentPlan.reviewer === "important" || currentPlan.reviewer === "important-twice" || currentPlan.reviewer === "confirm-fixed" || currentPlan.reviewer === "confirm-fixed-one-tool")
                && !text.includes("This is review round")
                && !(currentPlan.fixes === "change" && existsSync(join(conversation.cwd, "welcome.txt")))
              ) {
                const opus = conversation.model === (currentPlan.importantBy ?? "opus");
                if ((currentPlan.reviewer === "important" || currentPlan.reviewer === "confirm-fixed-one-tool") && !opus) {
                  return respond({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }], confirms: [], disputes: [] });
                }
                return respond({
                  verdict: "fail",
                  findings: [{
                    text: opus ? "The greeting is missing on the welcome page." : "The GREETING is missing on the welcome page!",
                    where: "greeting.txt",
                    severity: "important",
                    evidence: "Opened the welcome page",
                  }],
                  confirms: [],
                  disputes: [],
                });
              }
              return respond({
                verdict: "pass",
                findings: [{ text: "Consider a friendlier greeting.", severity: "nit", evidence: "On the current welcome page the greeting is still terse; a warmer greeting would be friendlier." }],
                confirms: [],
                disputes: [],
              });
            }
            case "verifier": {
              const ids = findingIds(text, "Important findings to check (a verdict on every one, by id)");
              const defaultVerdict = currentPlan.verifierByModel?.[conversation.model ?? ""]
                ?? (currentPlan.verifier === "after-fix-not-a-bug" ? (text.includes("  The builder: fixed.") ? "not-a-bug" : "real") : currentPlan.verifier === "not-a-bug" ? "not-a-bug" : "real");
              return respond({
                verdicts: ids.map(id => {
                  const given = currentPlan.verifierByFinding?.[id]?.[conversation.model ?? ""] ?? defaultVerdict;
                  return {
                    id,
                    verdict: given,
                    reason: given === "not-a-bug"
                      ? "The welcome page shows the greeting already."
                      : given === "real"
                        ? "The welcome page has no greeting: confirmed by opening it."
                        : `It is ${given === "nit" ? "only a nit" : "older than this change"}: checked on ${conversation.model}.`,
                  };
                }),
              });
            }
            default:
              return respond({ summary: `Notes from the ${conversation.role}.`, notes: [`A note from the ${conversation.role}`] });
          }
        },
        async cancel() {
          cancelled = true;
          wake?.();
        },
        close,
        stop,
      };
    };
  }

  async function reviewRun(reopen: Scenario["reopen"], input: ReviewerStageInput = {}) {
    const root = tempDir("petrina-context-review-");
    let browsers: string | undefined;
    const owner = directDrivers(root, { beforeRemoveRoot: () => { if (browsers) removeFixtureRoot(browsers); } });
    lifetimes.add(owner);
    const close = async () => { await owner.close(); lifetimes.delete(owner); };
    const opened = await setupWithCleanup(() => owner.prepare(async () => {
      if (input.browser) { browsers = testBrowserRoot(); registerFixtureRoot(browsers); }
      const fakes = new Fakes(join(root, "fake"));
      const scenario: Scenario = {
        planner: input.single ? "short" : "pair",
        builder: "plain",
        reviewer: input.reviewer ?? "important",
        fixes: "change",
        controlled: true,
        reopen,
        limited: input.limited,
      };
      fakes.scenario(scenario);
      let engine!: Engine;
      const failCheck = join(root, "fail-check");
      const expectedHeadScript = headCheckScript(failCheck);
      const startAgentSession = createSessionStarter(root, fakes, () => browsers, () => engine);
      const options: EngineOptions = {
        startAgentSession,
        agentCommand: () => [process.execPath],
        runCheckCommand: (req) => {
          if (req.argv.length === 3 && req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === expectedHeadScript) {
            return { code: existsSync(failCheck) ? 1 : 0, stdout: `CHECKED-CODE:${headNow(req.cwd)}\n` };
          }
          return undefined;
        },
        toolProbe: privateAgentToolProbe(),
        toolPath: () => process.execPath,
        browser: input.browser ?? false,
        browserRecovery: async () => {},
        ...(browsers ? { browserTempRoot: browsers } : {}),
      };
      const data = join(root, "data");
      const openEngine = () => installSharedWorkflowFastPaths(
        owner.open(data, options),
        { skipDriverPrepare: false, skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: !input.inspectDiffs, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true },
      );
      engine = openEngine();
      engine.setPoolPaused(true);
      await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
      await engine.checkTools(); engine.stopRequested.signal.throwIfAborted();
      engine.setPoolLimit(input.limit ?? 2);

      const seed = await getSeed(Boolean(input.advance));
      engine.stopRequested.signal.throwIfAborted();
      const products = [];
      const checkList = input.checks
        ? [{ name: "Exact code", argv: [process.execPath, "-e", headCheckScript(join(root, "fail-check"))], why: "Prove checks run on the current code" }]
        : [];
      for (const [id, name] of input.shared ? [["p", "Product"], ["second", "Second"]] : [["p", "Product"]]) {
        const repo = join(root, id!, "clone");
        mkdirSync(join(root, id!), { recursive: true });
        cpSync(seed.repo, repo, { recursive: true });
        installPreparedProduct(engine, { id: id!, name: name!, path: repo, repo: `local/${id}`, tone: "blue", defaultBranch: "main", delivery: "local", approveDelivery: true });
        const product = engine.s.products.find(product => product.id === id)!;
        product.checks = structuredClone(checkList);
        product.checksBy = "coordinator";
        products.push(product);
      }
      if (input.shared) fakes.scenario({ ...scenario, affectedProducts: products.map(product => product.id) });
      const choices = products.map(product => ({ productId: product.id, startFrom: { kind: "default" as const }, delivery: "local" as const }));
      const id = engine.addTask({
        productId: products[0]!.id,
        title: "Reuse independent reviewers",
        description: "ORIGINAL-REVIEW-REQUEST [no-check]",
        backlog: true,
        delivery: "local",
        approveDelivery: true,
        ...(input.shared ? { worksOn: choices } : {}),
      });
      let task = engine.task(id)!;
      task.risk = { level: scenario.risk ?? "medium", why: "Declared context-stage input" };
      const reviewerProfiles = input.settledHistory ? ["sol-high", "opus-high", "grok-high"] : input.single ? ["opus-high"] : review.profileIds;
      const draft: PlanDraft = { rationale: "Declared input before the first real review", stages: [build, { ...review, profileIds: reviewerProfiles }] };
      const plan = structuredClone(normalizePlan({
        task: { ...task, source: undefined },
        result: draft,
        roles: engine.s.roles,
        profiles: engine.s.profiles,
        plannerProfileId: "opus-high",
        releaseManagerProfileId: "opus-high",
        onUsable: profileId => engine.onUsable(profileId),
      })) as DeepMutable<NonNullable<Task["plan"]>>;
      task.plan = plan;
      const at = plan.stages.findIndex(stage => stage.kind === "review-chain");
      const works = [];
      for (const product of products) {
        const repo = product.path!, baseSha = seed.baseSha;
        const path = join(root, `work-${product.id}`), branch = `context-${product.id}`;
        engine.stopRequested.signal.throwIfAborted();
        cpSync(seed.worktree, path, { recursive: true });
        const oldWtMeta = join(repo, ".git", "worktrees", "work");
        const newWtMeta = join(repo, ".git", "worktrees", branch);
        if (existsSync(oldWtMeta) && oldWtMeta !== newWtMeta) renameSync(oldWtMeta, newWtMeta);
        writeFileSync(join(newWtMeta, "gitdir"), `${join(path, ".git")}\n`);
        writeFileSync(join(newWtMeta, "HEAD"), `ref: refs/heads/${branch}\n`);
        writeFileSync(join(path, ".git"), `gitdir: ${newWtMeta}\n`);
        const oldRef = join(repo, ".git", "refs", "heads", "seed-context");
        const newRef = join(repo, ".git", "refs", "heads", branch);
        if (existsSync(oldRef) && oldRef !== newRef) renameSync(oldRef, newRef);
        const oldLog = join(repo, ".git", "logs", "refs", "heads", "seed-context");
        const newLog = join(repo, ".git", "logs", "refs", "heads", branch);
        if (existsSync(oldLog) && oldLog !== newLog) renameSync(oldLog, newLog);
        engine.stopRequested.signal.throwIfAborted();
        works.push({
          productId: product.id,
          worktree: path,
          branch,
          baseSha,
          base: "main",
          delivery: "local" as const,
          workChoice: choices.find(choice => choice.productId === product.id)!,
          workProduct: { ...product },
          preparation: "ready" as const,
          completedStages: plan.stages.slice(0, at).filter(stage => stage.kind === "do").map(stage => stage.id),
          source: {
            product: { ...product },
            start: { kind: "default" as const, branch: "main" },
            destination: { kind: "branch" as const, mode: "local" as const, repo: product.repo, branch: "main" },
            initialSha: baseSha,
            confirmed: true,
          },
          report: { summary: "Prepared initial greeting report", changes: ["People see a greeting"], tests: "Supplied stage input; no earlier Builder execution is claimed" },
        });
      }
      if (input.shared) {
        delete task.repository;
        task.repositories = works;
        task.activeProductId = products[0]!.id;
        task.leadProductId = products[0]!.id;
      } else {
        task.repository = works[0]!;
      }
      task.brief = { summary: "ORIGINAL-DESIGN-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
      if (input.settledHistory) {
        task.findings.push({
          ...structuredClone(earlier),
          roleId: "code-reviewer",
          evidence: "Original settled reproduction and evidence. ".repeat(100),
          votes: [{ by: "opus-high", toolId: "claude-code", verdict: "real", reason: "Original independent judgment" }],
        });
        task.journey = [{
          id: "prior-examination",
          kind: "agent",
          roleId: "code-reviewer",
          stageId: "prior-stage",
          round: 0,
          sub: 0,
          startedAt: 2,
          endedAt: 3,
          result: {
            findingsSettled: true,
            findings: structuredClone(task.findings),
            findingChanges: { raised: [], fixed: [earlier.id], dismissed: [], claimedFixed: [earlier.id] },
          },
        }];
        engine.addTask({ productId: products[0]!.id, title: "Long original follow-up", description: "Original full follow-up evidence. ".repeat(100), kind: "bug", backlog: true });
      }
      Object.assign(task, { state: "waiting", startedAt: Date.now(), stageIndex: at, sub: 0, approvePlan: false, statusLine: "Waiting to start the prepared context stage" });
      for (const scope of scopesFor(task)) await engine.rememberVersion(scope, { head: seed.changeSha, tree: seed.changeTree });
      engine.commitNow(task);

      const current = () => engine;
      const run = <T>(start: () => Promise<T>) => { const bound = engine; return owner.run(bound, start); };
      const restart = () => owner.prepare(async () => {
        const previous = engine;
        await owner.stop(previous);
        engine = openEngine();
        await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
        task = engine.task(id)!;
      });
      const use = <T>(body: () => Promise<T>) => owner.prepare(body);
      return { root, seed, get browsers() { return browsers; }, fakes, options, products, task: () => task, engine: current, run, restart, use, start: () => engine.setPoolPaused(false), shutdown: () => owner.stop(engine), close };
    }), close);

    return setupWithCleanup(() => opened.use(async () => {
      const hold = join(opened.root, "hold-fixes");
      if (input.advance) {
        writeFileSync(hold, "");
        writeFixtureJson(join(opened.root, "script.json"), { hold: { title: "You are fixing the review findings", file: hold } });
      }
      const released = new Set<string>();
      const tick = (allow: (role: string, session: string) => boolean = () => true) => {
        for (const entry of opened.fakes.received()) if (allow(entry.role, entry.session) && !released.has(entry.session)) {
          writeFileSync(join(opened.fakes.dir, `release-${entry.session}`), "go");
          released.add(entry.session);
        }
        for (const item of opened.engine().getState().inbox) {
          if (item.kind === "question") opened.engine().answer(item.id, "Yes");
          else if (item.kind === "permission") opened.engine().allow(item.id, "once");
        }
        if (opened.task().state === "failed") throw new Error(opened.task().error);
      };
      const beforeFix = () => opened.run(() => waitFor(() => { tick(); return existsSync(`${hold}.reached`); }, "the controlled Builder fix"));
      type ReviewedTask = ReturnType<typeof opened.task>;
      function done(): Promise<ReviewedTask>;
      function done<T>(observe: (operation: Promise<ReviewedTask>) => Promise<T>): Promise<T>;
      function done<T>(observe?: (operation: Promise<ReviewedTask>) => Promise<T>): Promise<ReviewedTask | T> {
        return opened.run<ReviewedTask | T>(() => {
          rmSync(hold, { force: true });
          const operation = waitFor(() => { tick(); return opened.engine().getState().inbox.some(item => item.kind === "delivery") && opened.task(); }, "the reviewed delivery");
          return observe ? observe(operation) : operation;
        });
      };
      const advanceMain = (id = opened.products.at(-1)!.id, conflict = false) => opened.run(async () => {
        const product = opened.engine().s.products.find(product => product.id === id)!;
        const refFile = join(product.path!, ".git", "refs", "heads", "main");
        const before = readFileSync(refFile, "utf8").trim();
        writeFileSync(join(product.path!, "REVIEW.md"), "NEW-BASE-GUIDE\n");
        writeFileSync(join(product.path!, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
        const cachedAdvance = conflict ? opened.seed.advanceConflict : opened.seed.advanceClean;
        if (cachedAdvance && before === opened.seed.baseSha) {
          if (conflict) writeFileSync(join(product.path!, "greeting.txt"), "Main's incompatible greeting\n");
          for (const entry of readdirSync(cachedAdvance.objects)) {
            if (entry.length !== 2) continue;
            const srcSub = join(cachedAdvance.objects, entry);
            const dstSub = join(product.path!, ".git", "objects", entry);
            mkdirSync(dstSub, { recursive: true });
            for (const file of readdirSync(srcSub)) {
              const dstFile = join(dstSub, file);
              if (!existsSync(dstFile)) cpSync(join(srcSub, file), dstFile);
            }
          }
          cpSync(cachedAdvance.index, join(product.path!, ".git", "index"));
          writeFileSync(refFile, `${cachedAdvance.head}\n`);
          return { productId: id, before, base: cachedAdvance.head };
        }
        if (conflict) writeFileSync(join(product.path!, "greeting.txt"), "Main's incompatible greeting\n");
        await gitOps.commitChanges(product.path!, "Advance main independently");
        return { productId: id, before, base: readFileSync(refFile, "utf8").trim() };
      });
      opened.start();
      return { ...opened, browsers: opened.browsers!, hold, tick, done, beforeFix, advanceMain };
    }), opened.close);
  }

  return {
    reviewRun,
    close: async () => {
      await closeDirectDrivers([...lifetimes]);
      if (seedRoot) removeFixtureRoot(seedRoot);
    },
  };
}
