import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { sourcePrepared } from "../../fixtures/source-prepared.js";
import { sharedBrief } from "../../fixtures/shared-agents.js";
import { updateAgents, updatePlan } from "../../fixtures/update-agents.js";
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, BUILT_IN_ROLES, journeyProblems, stepName, type Task } from "@petrina/core";
import { executionFor, ParallelAdmissionGroup, type RepositoryContext } from "@petrina/orchestrator";
import { checkSetupContract } from "@petrina/repositories/check-environment";
import * as gitOps from "@petrina/repositories/git";
import { BuildResult } from "../../../src/roles.js";

import type { Scenario } from "../../fake-agent.js";
import { createProductRepository, waitFor } from "../../fixtures.js";
import { readLooseCommit } from "../../fixtures/shared-preparation.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


const posix = process.platform !== "win32";
const EMPTY_CHECKS_DEF = createHash("sha256").update("[]").digest("hex");
const EMPTY_SETUP_CONTRACT = checkSetupContract(undefined);
/** A commit on the product's own main, as another task landing there would make. */
async function land(repo: string, file: string, text: string, message: string): Promise<string> {
  writeFileSync(join(repo, file), text);
  await gitOps.commitChanges(repo, message);
  return readFileSync(join(repo, ".git", "refs", "heads", "main"), "utf8").trim();
}

function mainCommitsSince(repo: string, before: string): { sha: string; parents: string[]; subject: string }[] {
  const commonDir = join(repo, ".git");
  const out: { sha: string; parents: string[]; subject: string }[] = [];
  for (let cur = readFileSync(join(commonDir, "refs", "heads", "main"), "utf8").trim(); cur && cur !== before; ) {
    const c = readLooseCommit(commonDir, cur);
    if (!c) break;
    out.push({ sha: cur, parents: c.parents, subject: c.body.trim().split("\n")[0]! });
    cur = c.parents[0] ?? "";
  }
  return out;
}

/** A git hook in the product's own clone, local only, like one kept out of a public repository. */
function hook(repo: string, name: string, script: string): void {
  const path = join(repo, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

/**
 * One task to done on a product that commits to main locally. `setup` runs on the clone before it becomes a
 * product. `beforeBuild` runs at the first builder permission, once the working copy exists and before the
 * builder writes. `atDeliveryCheck` runs at the first delivery check, before the coordinator approves it.
 * `atBuilderPermission` can land main or add work while the scripted builder is waiting for permission. Each
 * hook finishes, Git included, before the engine gets the answer it is holding for.
 */
type Hook<T extends unknown[]> = (...args: T) => unknown;
async function prepareShip(owner: EngineCaseOwner, scenario: Scenario, hooks: { setup?: Hook<[repo: string]>; beforeBuild?: Hook<[repo: string]>; atDeliveryCheck?: Hook<[repo: string]>; atBuilderPermission?: Hook<[repo: string, task: Task]> } = {}) {
  const root = owner.root;
  const fakes = updateAgents(join(root, "replies"), scenario);
  const engine = owner.open(join(root, "data"), fakes);
  try {
    const { path: repo, initialSha: before } = await createProductRepository(root, { origin: "none" });
    await hooks.setup?.(repo);
    await engine.waitUntilReady(); owner.check(); engine.stopRequested.signal.throwIfAborted();
    engine["cleanup"].removeCopy = async () => {};
    engine["cleanup"].sweep = async () => {};
    engine["turns"].copyHeads.delete = () => false;
    const baseUpdateRepo = engine["updates"]["effects"].repository;
    let cachedFold: { head: string; tree: string; parent: string; message: string } | undefined;
    Object.assign(engine["updates"]["effects"], {
      sourceRef: async (path: string, ref: string) => {
        try { return readFileSync(join(path, ".git", ref), "utf8").trim(); }
        catch { return undefined; }
      },
      repository: (path: string) => {
        const real = baseUpdateRepo(path);
        if (scenario.mergesMain) return real;
        return {
          ...real,
          observeFold: async () => {
            const task = engine.s.tasks[0]?.repository;
            const tip = task?.branch ? readFileSync(join(repo, ".git", "refs", "heads", task.branch), "utf8").trim() : undefined;
            if (cachedFold && tip === cachedFold.head) {
              const hit = cachedFold;
              return {
                kind: "observed" as const,
                head: hit.head,
                tree: hit.tree,
                parents: [hit.parent],
                squash: async (fork: string, message: string) => {
                  if (hit.head === fork || (hit.parent === fork && hit.message.trim() === message.trim())) {
                    return { head: hit.head, tree: hit.tree };
                  }
                  const fresh = await (await real.observeFold()).squash(fork, message);
                  cachedFold = { head: fresh.head, tree: fresh.tree, parent: fork, message };
                  return fresh;
                },
              };
            }
            const obs = await real.observeFold();
            if (obs.kind === "observed") {
              return {
                ...obs,
                squash: async (fork: string, message: string) => {
                  const res = await obs.squash(fork, message);
                  cachedFold = { head: res.head, tree: res.tree, parent: fork, message };
                  return res;
                },
              };
            }
            return obs;
          },
          mergeBase: async () => engine.s.tasks[0]?.repository?.baseSha,
          contains: async () => true,
          isClean: async () => true,
          commitsSince: async () => 1,
          treeOf: async (ref?: string) => (!ref || ref === "HEAD") && engine.s.tasks[0]?.repository?.savedVersion?.tree
            ? engine.s.tasks[0]!.repository!.savedVersion!.tree
            : real.treeOf(ref),
          commitTree: async (tree: string, parent: string, message: string) => {
            const head = await real.commitTree(tree, parent, message);
            cachedFold = { head, tree, parent, message };
            return head;
          },
        };
      },
    });
    engine["updates"].patch = async (scope: RepositoryContext) => {
      const wt = scope.work.worktree!;
      const read = (file: string) => { try { return readFileSync(join(wt, file), "utf8"); } catch { return ""; } };
      return createHash("sha1").update(`${read("greeting.txt")}\0${read("welcome.txt")}`).digest("hex");
    };
    if (!scenario.leak) {
      engine["checks"].noteHooks = async () => [];
      engine["checks"]["captureState"] = async (scope: RepositoryContext) => ({
        sha: scope.work.savedVersion?.commit,
        tree: scope.work.savedVersion?.tree,
        trackedChanged: false,
        hooks: [],
        definition: EMPTY_CHECKS_DEF,
        contract: EMPTY_SETUP_CONTRACT,
        requiredCommands: "[]",
      });
    }
    engine["reviews"]["prepareChecks"] = async (scope: RepositoryContext, signal: AbortSignal) => {
      const { work } = scope;
      engine["updates"].clearObservedHead(scope);
      if (await engine["updates"].upToDate(scope, signal) === "conflict") return false;
      delete scope.task.handChanges;
      const sha = engine["updates"].consumeObservedHead(scope) ?? work.savedVersion?.commit ?? await gitOps.head(work.worktree!);
      work.tamper = { at: Date.now(), sha, problems: [] };
      engine.log(scope, "done", "Tamper check passed: no tests removed or skipped");
      return true;
    };
    Object.assign(engine["reviews"]["workflow"]["effects"], {
      input: async (scope: RepositoryContext) => {
        const head = scope.work.savedVersion?.commit ?? await gitOps.head(scope.work.worktree!);
        const tree = scope.work.savedVersion?.tree ?? (await gitOps.treeOf(scope.work.worktree!))!;
        const base = scope.work.baseSha ?? scope.work.base!;
        const snapshot = await engine["context"].captureReview(scope);
        snapshot.material = { title: "Prepared review material", body: scope.work.portReview ? "port comparison and resolved files for the previously reviewed change" : `complete comparison git diff ${base}...HEAD` };
        const digest = `${head}:${tree}:${base}:${scope.work.portReview ? "port" : "full"}`;
        engine["reviews"]["inputs"].set(scope.task, { digest, input: snapshot });
        return { file: "", digest, heads: { [scope.work.productId]: head }, trees: { [scope.work.productId]: tree } };
      },
    });
    Object.assign(engine["reviews"]["rounds"]["host"], {
      ownChanges: async (task: Task) => ({ [task.repository!.productId]: task.repository!.savedVersion?.tree ?? "change" }),
      anchor: async ({ work }: RepositoryContext) => ({ head: work.savedVersion?.commit, tree: work.savedVersion?.tree }),
    });
    engine["reviews"]["together"] = async (task, members, parentSignal, status) => {
      const scope = executionFor(task);
      const sha = task.hunt?.input?.heads[scope.work.productId] ?? scope.work.savedVersion?.commit ?? "";
      await engine["turns"].refresh(scope);
      const group = new ParallelAdmissionGroup({
        state: () => engine.s, activeState: () => engine.activeState(), now: () => Date.now(), draining: () => engine.draining,
        admissionsClosed: current => engine.taskAdmissionsClosed(current), admissionWait: current => engine.taskAdmissionWait(current), sourceRefreshDue: current => engine.taskSourceRefreshDue(current),
        selectScreen: current => engine.selectScreen(current), syncScreen: () => engine.syncScreen(), showReviewWork: current => engine.showReviewWork(current), finishStep: current => engine.finishStep(current), waitForUsage: (current, words) => engine.waitForUsage(current, words),
        rememberReviewer: (current, key, profileId) => engine["reviews"]["rememberReviewer"](current, key, profileId), changed: () => engine.commit(), checkpoint: () => engine.commitNow(), schedule: () => engine.schedule(),
      }, engine.agentAdmission);
      await group.run({ scope, members, signal: parentSignal, status, workspaces: {
        reference: () => scope.work.worktree!,
        prepare: async (_member, copy, _continuing, reuse) => ({
          activate: () => { if (!reuse) engine["turns"].copyHeads.set(copy, sha); },
          finish: () => {},
        }),
        stopHelpers: () => engine.stopHelpers(task.id),
        closeTaskRun: () => { const run = engine.runs.get(task.id); if (run) void engine.stopAgent(task.id, run).catch(() => undefined); },
        releasedStops: () => engine["turns"].releasedStops(task.id),
        finish: async () => {},
      } });
    };
    Object.assign(engine["driver"]["checkpoint"]["effects"], {
      head: async (scope: RepositoryContext) => scope.work.savedVersion?.commit ?? await gitOps.head(scope.work.worktree!),
      patch: (scope: RepositoryContext) => engine["updates"].patch(scope),
      committedCode: async (task: Task) => ({ [task.repository!.productId]: { sha: task.repository!.savedVersion!.commit, tree: task.repository!.savedVersion!.tree } }),
      versions: async (task: Task) => ({ [task.repository!.productId]: task.repository!.savedVersion!.tree }),
      invalidateAcceptance: async () => undefined,
      acceptanceVersion: (scope: RepositoryContext) => engine["updates"].patch(scope),
      writeGuide: async () => {},
      writeLearnings: async () => {},
      offerLearnings: async () => {},
    });
    engine["shipping"]["proofApprovalCurrent"] = async () => true;
    engine["shipping"]["backToWork"] = async (scope: RepositoryContext) => { await engine.agentCleanup.wait(scope.task.id); };
    engine["shipping"]["branchTip"] = async (scope: RepositoryContext) =>
      scope.work.savedVersion?.commit ?? readFileSync(join(repo, ".git", "refs", "heads", scope.work.branch!), "utf8").trim();
    engine["shipping"]["checkDelivery"] = async () => "continue" as const;
    engine["shipping"]["rememberDelivery"] = async (scope: RepositoryContext, sha: string, branch: string) => {
      scope.work.confirmedDelivery = { sha, tree: scope.work.savedVersion!.tree, branch, repo: product.repo, at: Date.now() };
    };
    engine["shipping"]["publishLocal"] = async (scope: RepositoryContext) => {
      const tested = scope.work.shipping!.prepared!.tested;
      writeFileSync(join(repo, ".git", "refs", "heads", "main"), `${tested}\n`);
      for (const file of ["greeting.txt", "welcome.txt"]) {
        try { writeFileSync(join(repo, file), readFileSync(join(scope.work.worktree!, file))); } catch {}
      }
      scope.work.shipping!.localUpdated = tested;
      return engine["shipping"]["recordLanded"](scope, "main", tested, "moved");
    };
    const productId = installPreparedProduct(engine, privateCloneProduct(repo));
    // Repository checks are declared inputs here; the real local pre-commit hook remains independent.
    const product = engine.s.products.find(product => product.id === productId)!;
    product.checks = []; product.checksBy = "coordinator";
    engine.setProductDelivery(productId, "local", true);
    let deliveryChecks = 0;
    let movedBeforeBuild = false;
    const beforeBuild = async (current: Task) => {
      if (!movedBeforeBuild) { movedBeforeBuild = true; await hooks.beforeBuild?.(repo); owner.check(); }
      await hooks.atBuilderPermission?.(repo, current); owner.check();
    };
    const taskId = await sourcePrepared(engine, { productId, title: "Add a greeting", description: "[no-check]", approvePlan: true },
      updatePlan(scenario, "[no-check]"), { kind: "builder", brief: sharedBrief(),
        // These two anchors inspect the real Builder's merge or hook preamble; all later repair/port turns stay real.
        ...(!scenario.mergesMain && !scenario.leak ? { beforeAdmission: id => {
          const phases = engine["driver"].workflow["phases"], ordinary = phases.doStage;
          let accepted = false;
          phases.doStage = async (bound, current, signal) => {
            if (bound.task.id !== id || accepted) return ordinary(bound, current, signal);
            const work = bound.work, path = work.worktree!;
            const startingTree = work.savedVersion?.tree;
            const profileId = bound.task.agent!.profileId;
            await beforeBuild(engine.getState().tasks.find(task => task.id === id)!);
            const result = BuildResult.parse(await fakes.acceptedInitialBuild(path, signal));
            accepted = true;
            beginAgentStep(bound.task, current.roleId, profileId, Date.now(), engine.s.roles, undefined, work);
            const sourceName = work.source!.start.kind === "pull-request" ? `PR #${work.source!.start.number}` : work.source!.start.branch;
            await engine["work"]["buildCompletion"].complete(bound, { stageId: current.id, roleId: current.roleId,
              plannedProfileId: current.profileIds[0]!, actualProfileId: profileId, result, maintenance: false,
              sourceName, startingTree, given: [], checkFailures: [] });
            return engine["work"]["completion"].complete(bound, { stageId: current.id, canEdit: true });
          };
        } } : {}),
      }, () => owner.check());
    const task = await waitFor(async () => {
      const state = engine.getState();
      const found = state.tasks.find((entry) => entry.id === taskId)!;
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") {
          // Approval itself happens while the working copy does not exist yet.
          engine.approve(item.id);
        } else if (item.kind === "permission") {
          if (found.agent?.roleId === "builder") {
            // The copy exists and the builder has not written yet, so a commit here is a later move.
            await beforeBuild(found);
          }
          engine.allow(item.id, "once");
        }
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        else if (item.kind === "delivery") {
          deliveryChecks += 1;
          if (deliveryChecks === 1) await hooks.atDeliveryCheck?.(repo);
          engine.approve(item.id);
        }
      }
      if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
      return found?.state === "done" && found;
    }, "the work to ship", 90_000);
    return { task, fakes, repo, before, deliveryChecks };
  } finally {
    try { await owner.stop(engine); }
    catch (error) { throw error; }
  }
}

function ship<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareShip>>) => Promise<T>, scenario: Scenario, hooks: { setup?: Hook<[repo: string]>; beforeBuild?: Hook<[repo: string]>; atDeliveryCheck?: Hook<[repo: string]>; atBuilderPermission?: Hook<[repo: string, task: Task]> } = {}): Promise<T> {
  return owner.prepare(async () => { const value = await prepareShip(owner, scenario, hooks); owner.check(); return body(value); });
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("a builder that brings main in itself", () => {
  it("has the work count from where the branch met main, so reviews see only its own changes and no merge commit lands", async () => {
    let landed = "";
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo, before }) => {
    expect(lines(task).some((line) => line.startsWith("The builder brought main into the branch itself"))).toBe(true);
    expect(task.baseSha).toBe(landed);
    // Every reviewer compared against the met main, not the base from before the merge.
    for (const review of fakes.openings("code reviewer")) expect(review).toContain(`git diff ${landed}...HEAD`);
    const commits = mainCommitsSince(repo, before);
    expect(commits.map(c => c.subject).join("\n")).toBe("Add a greeting\nNews on main");
    expect(commits.filter(c => c.parents.length > 1)).toHaveLength(0);

  }, { mergesMain: true }, { beforeBuild: async (repo) => (landed = await land(repo, "NEWS.md", "News\n", "News on main")) }));
});
});

describe.concurrent("work brought up to date with main", () => {
  it("brings the work up to date before a review starts, so no port is needed afterwards", async () => {
    let observedMain = "";
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo, before, deliveryChecks }) => {
    const text = lines(task);
    const updated = text.indexOf("Brought up to date with main (1 new commit there), with no conflicts");
    expect(updated).toBeGreaterThan(-1);
    expect(updated).toBeLessThan(text.indexOf("Code reviewer started"));
    expect(text.filter((line) => line.startsWith("Brought up to date with main"))).toHaveLength(1);
    // Every reviewer compared against the new main.
    const commits = mainCommitsSince(repo, before);
    const landed = commits[1]!.sha;
    expect(landed).toBe(observedMain);
    expect(task.baseSha).toBe(landed);
    expect(deliveryChecks).toBe(1);
    for (const review of fakes.openings("code reviewer")) expect(review).toContain(`git diff ${landed}...HEAD`);
    expect(commits.map(c => c.subject).join("\n")).toBe("Add a greeting\nNews on main");

  }, {}, { beforeBuild: async (repo) => (observedMain = await land(repo, "NEWS.md", "News\n", "News on main")) }));
});

  it("resolves main's conflict before spending the first acceptance turn", async () => {
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo, before, deliveryChecks }) => {
    const text = lines(task);
    const updateStep = task.journey!.find(step => step.kind === "agent" && step.update)!;
    const input = updateStep.agentInputs![0]!;
    expect(input.instructions).toContain("these files still have git's conflict markers: greeting.txt");
    expect(input.instructions).toContain("keep main's version of everything this task did not change");
    expect(fakes.prompts("builder").some(prompt => prompt.includes(input.instructions!))).toBe(true);
    expect(text).toContain("Main moved on (1 new commit) and 1 file conflicts with this work, so the builder brings it up to date");
    expect(text).toContain("Brought up to date with main: Added a greeting.");
    // The builder was told what conflicts and where to learn what main changed.
    const update = fakes.prompts("builder").find((prompt) => prompt.includes("conflict markers"));
    expect(update).toContain("these files still have git's conflict markers: greeting.txt");
    expect(update).toMatch(/git log --stat [0-9a-f]{40}\.\.[0-9a-f]{40}/);
    // No ordinary review happened before the conflict: the full planned review must still happen.
    const updated = text.indexOf("Brought up to date with main: Added a greeting.");
    expect(text.slice(updated).filter((line) => line === "Code reviewer started")).toHaveLength(2);
    expect(text.some((line) => line.startsWith("Port review passed"))).toBe(false);
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review).not.toContain("Review only the port");
      expect(review).toContain(`git diff ${task.baseSha}...HEAD`);
    }
    // The journey shows the move, the update and the full first review.
    const steps = task.journey ?? [];
    const names = steps.map((step, index) => stepName(step, steps.slice(0, index), BUILT_IN_ROLES));
    const moved = names.indexOf("Update branch");
    expect(moved).toBeGreaterThan(-1);
    expect(names[moved + 1]).toBe("Builder (update)");
    expect(names.slice(moved + 2).filter((name) => name.startsWith("Code reviewer"))[0]).toBe("Code reviewers");
    expect(steps.some((step) => step.port)).toBe(false);
    const reviewStep = steps.find((step) => step.roleId === "code-reviewer")!;
    expect(reviewStep.team).toHaveLength(2);
    expect(names.some((name) => name.includes("again"))).toBe(false);
    expect(journeyProblems(task)).toEqual([]);
    expect(deliveryChecks).toBe(1);
    expect(mainCommitsSince(repo, before).map(c => c.subject).join("\n")).toBe("Add a greeting\nA greeting on main");
    expect(readFileSync(join(repo, "greeting.txt"), "utf8")).not.toContain("<<<<<<<");

    const firstAcceptanceUpdate = text.indexOf("Brought up to date with main: Added a greeting.");
    expect(firstAcceptanceUpdate).toBeGreaterThan(-1);
    expect(text.indexOf("Tester started")).toBeGreaterThan(firstAcceptanceUpdate);
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(fakes.openings("code reviewer")).toHaveLength(2);
    expect(task.acceptancePassed).toBe(true);
    expect(journeyProblems(task)).toEqual([]);

  }, { planner: "tester-first" }, { beforeBuild: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") }));
});

  it("ships without asking again when main moves after the approval without touching the change", async () => {
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, repo, before, deliveryChecks }) => {
    const text = lines(task);
    expect(text.indexOf("Brought up to date with main (1 new commit there), with no conflicts")).toBeGreaterThan(text.indexOf("You approved the delivery"));
    expect(text.some((line) => line.includes("Petrina asks you again"))).toBe(false);
    expect(deliveryChecks).toBe(1);
    expect(mainCommitsSince(repo, before).map(c => c.subject).join("\n")).toBe("Add a greeting\nNews on main");

  }, {}, { atDeliveryCheck: (repo) => land(repo, "NEWS.md", "News\n", "News on main") }));
});

  it("asks again when a change made after the approval conflicts with main, once the builder brought it up to date and the review looked again", async () => {
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo, before, deliveryChecks }) => {
    expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
    // Both ordinary reviewers passed this exact feature; one independent reviewer can now review the port.
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(3);
    expect(reviews.slice(0, 2).every((prompt) => !prompt.includes("Review only the port"))).toBe(true);
    expect(reviews[2]).toContain("Review only the port of the already reviewed change, using the prepared port comparison and resolved files");
    expect(reviews[2]).toContain("resolving conflicts in: greeting.txt");
    expect(lines(task).some((line) => line.startsWith("Port review passed"))).toBe(true);
    const ports = task.journey!.filter((step) => step.port && step.roleId === "code-reviewer");
    expect(ports).toHaveLength(1);
    expect(ports[0]!.team ?? [ports[0]!.profileId]).toHaveLength(1);
    expect(task.reviewedTree).toBe(task.savedVersion?.tree);
    expect(journeyProblems(task)).toEqual([]);
    expect(deliveryChecks).toBe(2);
    expect(mainCommitsSince(repo, before).map(c => c.subject).join("\n")).toBe("Add a greeting\nA greeting on main");

  }, {}, { atDeliveryCheck: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") }));
});

  it("gives unreviewed fixes the full planned review when main conflicts during a fix round", async () => {
    let landed = false;
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo }) => {
    expect(landed).toBe(true);
    expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
    expect(readFileSync(join(repo, "welcome.txt"), "utf8")).toContain("Hello");
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(4);
    for (const review of reviews.slice(2)) {
      expect(review).not.toContain("Review only the port");
      expect(review).not.toContain("Review only what changed since");
      expect(review).toContain(`git diff ${task.baseSha}...HEAD`);
    }
    expect(task.findings.filter((finding) => finding.severity === "blocking").every((finding) => finding.status === "fixed")).toBe(true);
    expect(task.journey!.some((step) => step.port)).toBe(false);

  }, { reviewer: "important", fixes: "change" }, { atBuilderPermission: async (repo, current) => {
      if (!current.fixing || current.updating || landed) return;
      landed = true;
      await land(repo, "greeting.txt", "Hi from main\n", "A greeting on main");
    } }));
});

  it("reviews extra work done during a port with every planned reviewer", async () => {
    let added = false;
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo }) => {
    expect(added).toBe(true);
    expect(readFileSync(join(repo, "welcome.txt"), "utf8").trim()).toBe("An unreviewed welcome-page fix");
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(4);
    for (const review of reviews.slice(2)) {
      expect(review).not.toContain("Review only the port");
      expect(review).toContain(`git diff ${task.baseSha}...HEAD`);
    }
    expect(task.journey!.some((step) => step.port && step.roleId === "code-reviewer")).toBe(false);

  }, {}, {
      atDeliveryCheck: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main"),
      atBuilderPermission: (_repo, current) => {
        if (!current.updating) return;
        writeFileSync(join(current.worktree!, "welcome.txt"), "An unreviewed welcome-page fix\n");
        added = true;
      },
    }));
});
});

describe.concurrent.skipIf(!posix)("the repository's own commit hooks", () => {
  // Like a hook that keeps employer-internal names out of a public repository: local, never committed.
  const guard = `hits=$(git diff --cached -U0 --no-color | grep '^+' | grep -inE 'internal-db-[0-9]+')
if [ -n "$hits" ]; then echo "pre-commit: staged changes contain internal names; scrub them first:" >&2; echo "$hits" >&2; exit 1; fi`;

  it("runs a local pre-commit hook on the whole change, and its output sends the work back to the builder", async () => {
    return cases.use("petrina-update-", owner => ship(owner, async ({ task, fakes, repo, before }) => {
    const blocked = task.findings.find((finding) => finding.text === "Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)");
    expect(blocked?.evidence).toContain("staged changes contain internal names");
    expect(blocked?.evidence).toContain("internal-db-07");
    expect(blocked?.status).toBe("fixed");
    // The builder heard about the hook up front, and the fix round showed it what the hook said.
    expect(fakes.openings("builder")[0]).toContain("- Pre-commit hook: the repository's own");
    expect(fakes.prompts("builder").some((prompt) => prompt.includes("internal-db-07"))).toBe(true);
    const saved = fakes.prompts("builder").find((prompt) => prompt.includes("Saved failed-check output"))!.match(/- Pre-commit hook: ("[^"\n]+")/)!;
    expect(readFileSync(JSON.parse(saved[1]!), "utf8")).toContain("internal-db-07");
    // What landed is clean, as one commit, and the clone is back on its branch.
    expect(readFileSync(join(repo, "greeting.txt"), "utf8")).not.toContain("internal-db");
    expect(mainCommitsSince(repo, before).map(c => c.subject).join("\n")).toBe("Add a greeting");
    expect(readFileSync(join(repo, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/main");
    expect(readFileSync(join(repo, ".git", "refs", "heads", task.branch!), "utf8").trim()).toBe(readFileSync(join(repo, ".git", "refs", "heads", "main"), "utf8").trim());
    expect(task.hooking).toBeUndefined();

  }, { leak: true }, { setup: (repo) => hook(repo, "pre-commit", guard) }));
});

});

import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
