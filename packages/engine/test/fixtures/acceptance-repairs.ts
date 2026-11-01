import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "..");
import { acceptanceAgents } from "./acceptance-agents.js";
import { spyOn } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { applyAcceptanceVersions, completeAll, type DeepMutable, type Product, type Task, type WorkflowEvent } from "@petrina/core";
import { executionFor, ParallelAdmissionGroup, scopesFor, type RepositoryContext } from "@petrina/orchestrator";
import { checkSetupContract } from "@petrina/repositories/check-environment";
import * as gitOps from "@petrina/repositories/git";
import { createProductRepository, removeDir, tempDir, waitFor } from "../fixtures.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { Coordination } from "../../src/coordination.js";
import { SourceRefreshRequired } from "../../src/kernel.js";

const EMPTY_CHECKS_DEF = createHash("sha256").update("[]").digest("hex");
const EMPTY_SETUP_CONTRACT = checkSetupContract(undefined);

/** The parts of a review's completion report these cases read. */
type ReviewReport = WorkflowEvent & { openImportant: string[]; stillOpen: string[]; reopened: unknown[]; heldForDecision?: string[]; reportCounts: { closing: { open: { important: number } } } };

import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { installPreparedProduct } from "./prepared-product.js";
import { installAcceptedBuildCompletion } from "./check-build-completion.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";

interface AcceptanceWorktreeSeed {
  root: string;
  repo: string;
  worktree: string;
  index: string;
  head: string;
  tree: string;
}

const acceptanceSeeds = new Map<string, Promise<AcceptanceWorktreeSeed>>();
process.once("exit", () => {
  for (const seed of acceptanceSeeds.values()) {
    void seed.then(entry => removeDir(entry.root)).catch(() => {});
  }
});

function copyLooseObjects(srcObjects: string, dstObjects: string): void {
  for (const entry of readdirSync(srcObjects)) {
    if (entry.length !== 2) continue;
    const sub = join(srcObjects, entry);
    const dstSub = join(dstObjects, entry);
    mkdirSync(dstSub, { recursive: true });
    for (const file of readdirSync(sub)) {
      const dstFile = join(dstSub, file);
      if (!existsSync(dstFile)) cpSync(join(sub, file), dstFile);
    }
  }
}

function getAcceptanceSeed(baseSha: string): Promise<AcceptanceWorktreeSeed> {
  let pending = acceptanceSeeds.get(baseSha);
  if (!pending) {
    pending = (async () => {
      const root = tempDir("petrina-acceptance-seed-");
      const { path: repo } = await createProductRepository(root, { origin: "none" });
      const worktree = join(root, "work");
      await gitOps.ensureWorktree(repo, worktree, "seed-greeting", baseSha);
      writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
      const message = "Show the greeting\n\nAdded the greeting.\n\n- People see a greeting\n\nBuilt by Petrina: Builder (GPT-5.4, high)";
      await gitOps.commitChanges(worktree, message);
      const gitDir = resolve(worktree, readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
      const head = readFileSync(join(repo, ".git", "refs", "heads", "seed-greeting"), "utf8").trim();
      const raw = inflateSync(readFileSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)))).toString("utf8");
      const tree = /\0tree ([0-9a-f]{40,64})\n/.exec(raw)?.[1] ?? "";
      return { root, repo, worktree, index: join(gitDir, "index"), head, tree };
    })();
    acceptanceSeeds.set(baseSha, pending);
  }
  return pending;
}

export const GREETING = "People see the greeting on the welcome page";
export const PHONE = "The greeting reads well on a phone";
export const UNAVAILABLE = "The phone simulator is unavailable, so the page could not be opened on a phone.";
export const failing = (productIds: string[], text = GREETING) => ({ text, result: "fail" as const, evidence: "Opened the welcome page: no greeting appears; expected it at the top.", productIds });
export const passed = (productIds: string[], text = GREETING) => ({ text, result: "pass" as const, evidence: `Opened the welcome page and saw: ${text}`, productIds });
export const blocked = (productIds: string[], text = PHONE) => ({ text, result: "blocked" as const, reason: UNAVAILABLE, evidence: "Tried to start the phone simulator twice; it never opened.", productIds });

export const REPAIR_CHECK = "Checking the builder's repair of the failed acceptance checks; the planned reviews follow";
export const FINAL_TEST = "Final acceptance testing after review: the final code needs current acceptance evidence";
export const STILL_FAILS = "Acceptance still fails: the builder returns are unavailable or used up. The remaining reviews run first, then the decision goes to you at your delivery check";
/** Every planned review seat, once: the code review's two seats and the security review. */
export const ALL_SEATS = ["review:1:code-reviewer:opus-high", "review:1:code-reviewer:sol-high", "security:1:security-reviewer:opus-high"];

/**
 * A shared task past its build, on two products: acceptance testing, a code review with two seats, a security review,
 * then publishing, with or without a delivery check planned from the start. The coding tools are the scripted stand-ins.
 */
export function acceptanceRepairFixtures() {
  const fixtures = new Set<ReturnType<typeof directDrivers>>();
  const close = async () => { await closeDirectDrivers(fixtures); fixtures.clear(); };
  async function fixture(options: { gate: boolean; checklist?: readonly string[]; custom?: boolean; acceptedBuilds?: boolean }) {
    const root = tempDir("petrina-acceptance-repair-");
    const lifetime = directDrivers(root); fixtures.add(lifetime);
    const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
    return setupWithCleanup(() => lifetime.prepare(async () => {
      const responses = acceptanceAgents();
      const engineOptions = { agentCommand: () => [process.execPath, join(TEST_FIXTURE_ROOT, "unconfigured-service.ts"), "acceptance fixture"], startAgentSession: responses.start, toolProbe: privateAgentToolProbe(), terminals: () => [] };
      const engine = lifetime.open(join(root, "data"), engineOptions);
      engine.schedule = () => {};
      await engine.waitUntilReady();
      engine.setPoolPaused(false);
      const products: DeepMutable<Product>[] = [];
      const initialVersions = new Map<DeepMutable<Product>, string>();
      for (let i = 0; i < 2; i++) {
        const dir = join(root, `product-${i}`); mkdirSync(dir);
        const { path: repo, initialSha } = await createProductRepository(dir, { origin: "none" });
        const id = installPreparedProduct(engine, { id: i === 0 ? "clone" : "clone-2", path: repo, name: `Product ${i + 1}`, repo: "local/clone",
          tone: i === 0 ? "blue" : "green", defaultBranch: "main", delivery: "local", approveDelivery: options.gate });
        const product = engine.s.products.find(product => product.id === id)!;
        // Cases about a real command install that command explicitly before driving.
        // Ordinary acceptance/review routing has no product command to execute.
        product.checks = []; product.checksBy = "coordinator";
        products.push(product);
        initialVersions.set(product, initialSha);
      }
      const task = engine.task(engine.addTask({ productId: products[0]!.id, title: "Show the greeting", backlog: true }))!;
      const owners = [];
      for (const [i, product] of products.entries()) {
        const baseSha = initialVersions.get(product);
        if (!baseSha) throw new Error("The private acceptance product lost its initial commit");
        const worktree = join(root, `work-${i}`), branch = `greeting-${i}`;
        const seed = await getAcceptanceSeed(baseSha);
        copyLooseObjects(join(seed.repo, ".git", "objects"), join(product.path!, ".git", "objects"));
        mkdirSync(worktree, { recursive: true });
        for (const entryName of readdirSync(seed.worktree)) {
          if (entryName === ".git") continue;
          cpSync(join(seed.worktree, entryName), join(worktree, entryName), { recursive: true });
        }
        const wtGitDir = join(product.path!, ".git", "worktrees", branch);
        mkdirSync(wtGitDir, { recursive: true });
        writeFileSync(join(wtGitDir, "commondir"), "../..\n");
        writeFileSync(join(wtGitDir, "gitdir"), `${join(worktree, ".git")}\n`);
        writeFileSync(join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
        cpSync(seed.index, join(wtGitDir, "index"));
        writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
        const refFile = join(product.path!, ".git", "refs", "heads", branch);
        mkdirSync(dirname(refFile), { recursive: true });
        writeFileSync(refFile, `${seed.head}\n`);
        owners.push({ productId: product.id, worktree, baseSha, base: baseSha, branch, delivery: "local" as const, completedStages: ["build"], preparation: "ready" as const,
          savedVersion: { commit: seed.head, tree: seed.tree },
          report: { title: "Show the greeting", summary: "Added the greeting.", changes: ["People see a greeting"], tests: "Focused tests pass." },
          source: { product, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true } });
      }
      delete task.repository; task.repositories = owners; task.activeProductId = products[0]!.id;
      const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
      const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
      // Petrina finds the acceptance role by its checks result, whatever it is called.
      if (options.custom) { engine.s.roles.push({ ...engine.role("tester")!, id: "quality-partner", name: "Quality partner" }); tester.roleId = "quality-partner"; }
      const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"], maxRounds: 2 };
      const security = { id: "security", title: "Security review", kind: "review-chain" as const, roleId: "security-reviewer", profileIds: ["opus-high"], maxRounds: 2 };
      const gate = { id: "gate", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] };
      const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
      task.plan = { rationale: "Focused shared acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, security, ...(options.gate ? [gate] : []), ship] };
      task.approveDelivery = options.gate;
      task.brief = { summary: "Show the greeting", areas: [], forUsers: [], risks: [], acceptance: (options.checklist ?? [GREETING]).map(text => ({ text })) };
      task.state = "running"; task.stageIndex = 1;
      const prepareBuilds = (generation: typeof engine) => {
        installSharedWorkflowFastPaths(generation, { skipUpToDate: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
        generation["cleanup"].sweep = async () => {};
        generation["turns"].copyHeads.delete = () => false;
        generation["guide"].proposeGuideLine = async () => {};
        generation["updates"].patch = async (scope: RepositoryContext) => {
          const wt = scope.work.worktree!;
          const read = (file: string) => { try { return readFileSync(join(wt, file), "utf8"); } catch { return ""; } };
          return createHash("sha1").update(`${read("greeting.txt")}\0${read("welcome.txt")}`).digest("hex");
        };
        const origUpToDate = generation["updates"].upToDate.bind(generation["updates"]);
        generation["updates"].upToDate = async (scope, signal) => {
          if (!scope.work.updating && scope.work.savedVersion?.commit) {
            if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
            generation["updates"]["observedHeads"].set(scope.work, scope.work.savedVersion.commit);
            return "current";
          }
          return origUpToDate(scope, signal);
        };
        const origFold = generation["updates"].fold.bind(generation["updates"]);
        generation["updates"].fold = async (scope) => {
          if (scope.work.savedVersion?.commit && scope.work.savedVersion.commit !== scope.work.baseSha && scope.work.worktree && !existsSync(join(scope.work.worktree, "welcome.txt"))) {
            generation["updates"]["observedHeads"].set(scope.work, scope.work.savedVersion.commit);
            return { fork: scope.work.baseSha!, version: { head: scope.work.savedVersion.commit, tree: scope.work.savedVersion.tree } };
          }
          return origFold(scope);
        };
        const origSaveChanges = generation["work"]["buildCompletion"]["effects"].saveChanges.bind(generation["work"]["buildCompletion"]["effects"]);
        generation["work"]["buildCompletion"]["effects"].saveChanges = async (scope) => {
          if (scope.work.savedVersion?.commit && scope.work.savedVersion.commit !== scope.work.baseSha && scope.work.worktree && !existsSync(join(scope.work.worktree, "welcome.txt"))) return;
          return origSaveChanges(scope);
        };
        const origCaptureState = generation["checks"]["captureState"].bind(generation["checks"]);
        generation["checks"].noteHooks = async () => [];
        generation["checks"]["captureState"] = async (scope, checks) => {
          const product = generation.productOf(scope);
          if ((!product?.checks || product.checks.length === 0) && checks.length === 0 && scope.work.savedVersion) {
            const invalidationId = scope.work.checkSetupInvalidated?.id;
            return {
              sha: scope.work.savedVersion.commit, tree: scope.work.savedVersion.tree,
              trackedChanged: false, hooks: [],
              definition: EMPTY_CHECKS_DEF, contract: EMPTY_SETUP_CONTRACT, requiredCommands: "[]",
              ...(invalidationId ? { invalidationId } : {}),
            };
          }
          return origCaptureState(scope, checks);
        };
        generation["reviews"]["prepareChecks"] = async (scope, signal) => {
          generation["updates"].clearObservedHead(scope);
          if (await generation["updates"].upToDate(scope, signal) === "conflict") return false;
          delete scope.task.handChanges;
          const sha = generation["updates"].consumeObservedHead(scope) ?? scope.work.savedVersion?.commit ?? "";
          scope.work.tamper = { at: Date.now(), sha, problems: [] };
          generation.log(scope, "done", "Tamper check passed: no tests removed or skipped");
          return true;
        };
        const reviews = generation["reviews"];
        reviews["together"] = async (currentTask, members, parentSignal, status) => {
          const scope = executionFor(currentTask);
          const versions = currentTask.repositories ? currentTask.repositories.map((work) => {
            const restoreSha = work.savedVersion?.commit ?? "";
            return { productId: work.productId, root: work.source!.product.path!, path: work.worktree!, restoreSha, sha: currentTask.hunt?.input?.heads[work.productId] ?? restoreSha };
          }) : [];
          const sha = currentTask.hunt?.input?.heads[scope.work.productId] ?? scope.work.savedVersion?.commit ?? "";
          await generation["turns"].refresh(scope);
          if (generation.taskSourceRefreshDue(currentTask)) throw new SourceRefreshRequired();
          const group = new ParallelAdmissionGroup({
            state: () => generation.s, activeState: () => generation.activeState(), now: () => Date.now(), draining: () => generation.draining,
            admissionsClosed: t => generation.taskAdmissionsClosed(t), admissionWait: t => generation.taskAdmissionWait(t), sourceRefreshDue: t => generation.taskSourceRefreshDue(t),
            selectScreen: t => generation.selectScreen(t), syncScreen: () => generation.syncScreen(), showReviewWork: t => generation.showReviewWork(t), finishStep: t => generation.finishStep(t), waitForUsage: (t, words) => generation.waitForUsage(t, words),
            rememberReviewer: (t, key, profileId) => reviews["rememberReviewer"](t, key, profileId), changed: () => generation.commit(), checkpoint: () => generation.commitNow(), schedule: () => generation.schedule(),
          }, generation.agentAdmission);
          await group.run({ scope, members, signal: parentSignal, status, workspaces: {
            reference: () => scope.work.worktree!,
            prepare: async (member, copy, _continuing, reuse) => {
              const copies: Record<string, string> = { [scope.work.productId]: scope.work.worktree! };
              for (const work of versions) if (work.productId !== scope.work.productId) copies[work.productId] = work.path;
              return {
                activate: () => {
                  if (versions.length) generation["turns"].repositoryCopies.set(copy, copies);
                  if (!reuse && sha) generation["turns"].copyHeads.set(copy, sha);
                },
                finish: () => {
                  const saved = currentTask.hunt?.screenTurns?.[member.key];
                  if (saved && versions.length) { saved.copies = copies; saved.conversation.repositoryCopies = copies; generation.commitNow(); }
                },
              };
            },
            stopHelpers: () => generation.stopHelpers(currentTask.id),
            closeTaskRun: () => { const run = generation.runs.get(currentTask.id); if (run) void generation.stopAgent(currentTask.id, run).catch(() => undefined); },
            releasedStops: () => generation["turns"].releasedStops(currentTask.id),
            finish: async () => {
              generation["turns"].repositoryCopies.delete(scope.work.worktree!);
            },
          } });
        };
        reviews["rounds"]["host"].ownChanges = async (currentTask) => Object.fromEntries(scopesFor(currentTask).map(s => [s.work.productId, s.work.savedVersion?.tree ?? "change"]));
        reviews["rounds"]["host"].anchor = async ({ work }) => ({ head: work.savedVersion?.commit, tree: work.savedVersion?.tree });
        const taskVersions = async (currentTask: Parameters<typeof scopesFor>[0]) => Object.fromEntries(scopesFor(currentTask).map(s => [s.work.productId, s.work.savedVersion?.tree ?? s.work.baseSha ?? ""]));
        const committedCode = async (currentTask: Parameters<typeof scopesFor>[0]) => {
          const versions = await taskVersions(currentTask);
          return { versions, changes: { ...versions } };
        };
        const checkpointEffects = generation["driver"]["checkpoint"]["effects"];
        checkpointEffects.head = async (scope) => scope.work.savedVersion?.commit ?? "";
        checkpointEffects.patch = (scope) => generation["updates"].patch(scope);
        checkpointEffects.committedCode = committedCode;
        checkpointEffects.versions = taskVersions;
        checkpointEffects.invalidateAcceptance = async (currentTask, versions) => {
          const current = versions ?? await taskVersions(currentTask);
          applyAcceptanceVersions(currentTask, current);
          return current;
        };
        checkpointEffects.acceptanceVersion = async (scope, versions) => JSON.stringify(versions ?? await taskVersions(scope.task));
        checkpointEffects.writeGuide = async () => {};
        checkpointEffects.writeLearnings = async () => {};
        checkpointEffects.offerLearnings = async () => {};
        const acceptanceEffects = generation["work"]["acceptanceStep"]["effects"];
        acceptanceEffects.committedCode = committedCode;
        acceptanceEffects.versions = taskVersions;
        if (options.acceptedBuilds) installAcceptedBuildCompletion(generation, task.id, responses, () => generation.stopRequested.signal.throwIfAborted());
      };
      prepareBuilds(engine);
      const f = {
        root, responses, engine, task, products, close, ids: products.map(product => product.id) as [string, string], review, security, tester: tester.roleId,
        mains: () => {
          const engine = f.engine;
          return lifetime.run(engine, () => completeAll(products.map(async product => (await gitOps.revParse(product.path!, "main"))!)));
        },
        /** Runs the task until it waits, stops, or (with `stop`) is about to admit an agent while `stop` holds. */
        drive: (stop?: (task: Task) => boolean) => {
          const engine = f.engine, task = f.task;
          return lifetime.run(engine, async () => {
            const admit = spyOn(engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockImplementation(async () => {
              if (stop?.(task as Task)) return false;
              if (options.acceptedBuilds) {
                const stage = task.plan?.stages[task.stageIndex];
                if (stage) task.agent = { roleId: stage.roleId, profileId: stage.profileIds[0]!, since: Date.now(), step: 0 };
              }
              return true;
            });
            try { task.state = "running"; await engine["driver"].workflow["drive"](task.id); if (engine.task(task.id)?.state === "failed") throw new Error(task.error); }
            finally { admit.mockRestore(); }
          });
        },
        decisions: () => f.engine.s.inbox.filter(item => item.taskId === f.task.id && item.kind === "delivery"),
        /** Finished agent steps of one role, in the order they ran. */
        runs: (roleId: string) => f.task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId && step.endedAt !== undefined),
        /** Which planned review seats actually handed back a result: review stage, round, role and profile. */
        seats: () => f.task.journey!.filter(step => step.kind === "agent" && (step.stageId === review.id || step.stageId === security.id))
          .flatMap(step => (step.agentResults ?? []).filter(result => result.roleId === "code-reviewer" || result.roleId === "security-reviewer").map(result => `${step.stageId}:${step.round}:${result.roleId}:${result.profileId}`)).sort(),
        /** The work as it happened: each agent step's stage (with the Builder's product) and each delivery decision. */
        order: () => f.task.journey!.flatMap(step => step.kind === "agent" && step.roleId !== "verifier" ? [step.builderReturn ? `build:${f.ids.indexOf(step.builderReturn.productId) + 1}` : step.stageId!]
          : step.kind === "you" && step.waitsFor === "delivery" ? ["decision"] : []),
        heldFailure: () => f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`),
        /** The reviews' completion reports, as a coordinator watching the task reads them. */
        reviewReports: () => {
          const engine = f.engine, taskId = f.task.id;
          return lifetime.run(engine, async () => ((await new Coordination(engine).call("watch.events", { taskIds: [taskId], kinds: ["review.finished"], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[]).filter(event => event.kind === "review.finished") as unknown as ReviewReport[]);
        },
        /** Petrina quits and starts again on the same saved state. */
        restart: () => lifetime.prepare(async () => {
          const previous = f.engine, taskId = f.task.id;
          previous.setPoolPaused(true); await lifetime.stop(previous);
          const replacement = lifetime.open(previous.dataDir, engineOptions);
          f.engine = replacement;
          replacement.schedule = () => {};
          await replacement.waitUntilReady(); replacement.setPoolPaused(false);
          // A returning Builder waits for its tool's check, which a start runs again.
          await waitFor(() => !replacement.s.setup?.checks.some(check => check.checking), "the tool checks after the restart");
          f.task = replacement.task(taskId)!;
          prepareBuilds(replacement);
        }),
      };
      return f;
    }), close);
  }
  return { fixture, close };
}
