import { expectRejection } from "./rejections.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { beginAgentStep } from "@petrina/core";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as github from "../src/github.js";
import * as gitOps from "../src/git.js";
import { versionsOf, invalidateAcceptance, acceptanceVersion } from "../src/repositories.js";
import { beginRepair } from "@petrina/orchestrator";
import { Cleanup } from "../src/cleanup.js";
import { scopesFor, detachRepositoryState, executionFor } from "@petrina/orchestrator";
import { Learnings } from "../src/learnings.js";
import type { MachineRecords } from "../src/check-interruption.js";
import { git, makeWorld, removeDir, waitFor, type World } from "./support.js";

const worlds: World[] = [];
afterAll(() => worlds.forEach((world) => removeDir(world.dir)));

async function fixture(name: string, machineRecords?: MachineRecords) {
  const first = await makeWorld(`context-first-${name}`), second = await makeWorld(`context-second-${name}`);
  worlds.push(first, second);
  const start = () => first.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [], ...(machineRecords ? { machineRecords } : {}) });
  const engine = start();
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  const products = [first, second].map((world, index) => ({ id: index ? "second" : "first", name: index ? "Second" : "First", repo: index ? "acme/second" : "acme/first", path: world.clone, tone: "blue" as const }));
  engine.s.products.push(...products);
  const id = engine.addTask({ productId: "first", title: "Keep each repository's execution state", backlog: true });
  const task = engine.task(id)!;
  task.repositories = products.map((product) => ({ productId: product.id, worktree: product.path, delivery: "local", branch: `task-${product.id}`, report: { summary: `${product.id} report`, changes: [] }, builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "sol", sessionId: `${product.id}-conversation` }, completedStages: [] }));
  task.activeProductId = "first";
  detachRepositoryState(task);
  return { engine, start, task, id };
}

describe("explicit repository execution contexts", () => {
  it("uses frozen repair roles, complete findings and real acceptance trees without automated checks", async () => {
    const { engine, task } = await fixture("repair-context");
    try {
      const role = { ...engine.role("builder")!, id: "saved-maintenance" };
      task.maintenance = { routineId: "routine", routineName: "Routine", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role, profile: engine.s.profiles[0]!, product: engine.s.products[0]! };
      task.plan = { rationale: "Repair", plannerProfileId: "sol-high", stages: [{ id: "build", title: "Maintain", kind: "do", roleId: role.id, profileIds: ["sol-high"] }] };
      task.findings = [{ id: "failure", text: "The defect", severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"], productIds: ["first"], steps: "Exact reproduction", votes: [{ by: "grok-high", toolId: "grok", verdict: "real", reason: "Independent diagnostic" }] }];
      expect(beginRepair(engine, task, "review", 1)).toBe(true);
      const repair = await engine["context"].sectionsFor(executionFor(task), role.id);
      const body = repair.find(section => section.title.startsWith("Review findings"))!.body;
      expect(body).toContain("Exact reproduction");
      expect(body).toContain("Independent diagnostic");
      const versions = await versionsOf(task);
      task.retest = true;
      task.journey = [{ id: "prior-test", kind: "agent", roleId: "tester", round: 1, sub: 0, startedAt: 1, endedAt: 3, agentResults: [{ roleId: "tester", profileId: "sol-high", at: 2, versions, value: { summary: "Earlier incomplete acceptance", checks: [] } }] }];
      const read = async () => (await engine["context"].sectionsFor(executionFor(task), "tester")).find(section => section.title === "Why acceptance testing runs again")!.body;
      expect(await read()).toContain("Products with changed trees: none");
      await git(task.repositories![1]!.worktree!, "commit", "--allow-empty", "-m", "Same tree");
      expect(await read()).toContain("Products with changed trees: none");
      writeFileSync(join(task.repositories![1]!.worktree!, "changed.txt"), "Actual change");
      await git(task.repositories![1]!.worktree!, "add", "changed.txt");
      await git(task.repositories![1]!.worktree!, "commit", "-m", "Changed tree");
      expect(await read()).toContain("Products with changed trees: second");
    } finally { await engine.shutdown(); }
  });
  it("discards saved screen copies through their approved repository roots, including an excluded product", async () => {
    const { engine, task } = await fixture("screen-owner-roots");
    const owners = task.repositories!;
    const paths = owners.map(work => work.worktree!);
    owners.forEach((work, index) => { work.source = { product: { ...engine.s.products[index]!, path: paths[index]! }, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: "acme/demo", branch: "main" }, confirmed: true }; });
    task.excludedRepositories = [owners.pop()!];
    engine.s.products.forEach(product => { product.path = "/a/different/clone"; });
    task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0, screenTurns: { "review-0": {
      copy: "saved", reason: "Check the page", at: 1,
      conversation: { roleId: "code-reviewer", profileId: "sol-high", sessionId: "saved", toolId: "codex", model: "sol", step: "review", startedAt: 1 },
    } } };
    const cleanup = spyOn(gitOps, "removeCopies").mockResolvedValue(undefined);
    try {
      engine.discardScreenTurns(task);
      await engine.copyCleanups.get(task.id);
      expect(cleanup.mock.calls.map(call => call[0])).toEqual(paths);
      expect(task.hunt!.screenTurns).toBeUndefined();
    } finally { cleanup.mockRestore(); await engine.shutdown(); }
  });

  it("waits for every owner's screen-copy cleanup even when one fails", async () => {
    const { engine, task } = await fixture("concurrent-screen-cleanup");
    const paths = task.repositories!.map(work => work.worktree!);
    task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0, screenTurns: { "review-0": {
      copy: "saved", reason: "Check the page", at: 1,
      conversation: { roleId: "code-reviewer", profileId: "sol-high", sessionId: "saved", toolId: "codex", model: "sol", step: "review", startedAt: 1 },
    } } };
    const gates = paths.map(() => Promise.withResolvers<void>());
    const cleanup = spyOn(gitOps, "removeCopies").mockImplementation(async root => gates[paths.indexOf(root)]!.promise);
    try {
      engine.discardScreenTurns(task);
      const pending = engine.copyCleanups.get(task.id)!;
      await waitFor(() => cleanup.mock.calls.length === 2, "both owners to begin cleanup");
      gates[0]!.reject(new Error("First owner cleanup failed"));
      await Promise.resolve(); await Promise.resolve();
      expect(engine.copyCleanups.get(task.id)).toBe(pending);
      gates[1]!.resolve();
      await pending;
      expect(engine.copyCleanups.has(task.id)).toBe(false);
      expect(task.timeline.some(line => line.text.includes("First owner cleanup failed"))).toBe(true);
    } finally { gates.forEach(gate => gate.resolve()); cleanup.mockRestore(); await engine.shutdown(); }
  });

  for (const proof of [false, true]) for (const canEdit of [false, true]) it(`uses one acceptance snapshot per product${canEdit ? " after saving tester edits once" : " for a read-only tester"}${proof ? " with required proof" : ""}`, async () => {
    const { engine, task } = await fixture(`tester-versions-${canEdit}-${proof}`);
    const role = { ...engine.role("tester")!, id: "acceptance-specialist", name: "Acceptance specialist", canEdit };
    engine.s.roles.push(role);
    const stage = { id: "test", title: "Acceptance", kind: "do" as const, roleId: role.id, profileIds: ["sol-high"] };
    task.plan = { rationale: "Verify both products", plannerProfileId: "sol-high", stages: [stage] };
    task.stageIndex = 0;
    task.brief = { summary: "Together", forUsers: [], areas: [], risks: [], acceptance: [{ text: "Both products work" }] };
    const scope = executionFor(task);
    const before = await versionsOf(task);
    if (proof) task.proofRequests = [{ id: "required-proof", source: "review:1:0:0", text: "Prove both products on the final code", reason: "Both versions must match", productIds: task.repositories!.map(work => work.productId), requestedBy: { stageId: "review", round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" }, reviewedVersions: before, ownerStageId: stage.id, status: "pending" }];
    const turn = spyOn(engine["turns"], "turn").mockImplementation(async (_scope, _role, _profile, _given, schema, _signal, options) => {
      options?.used?.("opus-high");
      if (canEdit) writeFileSync(join(scope.work.worktree!, "tester-fix.txt"), "A focused tester repair\n");
      const value = schema.parse({ summary: "Verified", checks: [{ text: "Both products work", result: "pass", productIds: task.repositories!.map(work => work.productId), evidence: "Exercised both products" }], proofAnswers: proof ? [{ id: "required-proof", result: "pass", evidence: "Exercised both prepared product versions" }] : [], learnings: [] });
      const step = beginAgentStep(task, role.id, "opus-high", Date.now(), engine.s.roles, undefined, scope.work);
      step.agentResults = [{ roleId: role.id, profileId: "opus-high", at: Date.now(), value }];
      return value;
    });
    const tree = spyOn(gitOps, "treeOf"), save = spyOn(engine, "saveRoleEdits");
    try {
      expect(await engine["work"].runDo(scope, stage, new AbortController().signal)).toBe("continue");
      expect(tree).toHaveBeenCalledTimes(canEdit || proof ? 4 : 2);
      for (const work of task.repositories!) expect(tree.mock.calls.filter(([path]) => path === work.worktree)).toHaveLength(canEdit || proof ? 2 : 1);
      expect(save).toHaveBeenCalledTimes(canEdit ? 1 : 0);
      if (canEdit) expect(save).toHaveBeenCalledWith(scope, role.id, "opus-high");
      expect(task.acceptancePassed).toBe(!(proof && canEdit));
      expect(task.testedPatch).toBe(JSON.stringify(task.testedVersions));
      expect(task.brief.acceptance[0]!.versions).toEqual(task.testedVersions);
      expect(task.brief.acceptance[0]!.verification).toBe("passed");
      if (canEdit) expect(task.testedVersions![scope.work.productId]).not.toBe(before[scope.work.productId]);
      else expect(task.testedVersions).toEqual(before);
      if (proof) {
        expect(task.proofRequests![0]!.proof!.versions).toEqual(before);
        expect(task.proofRequests![0]!.proof!.result).toBe("pass");
        expect(task.proofRequests![0]!.status).toBe(canEdit ? "stale" : "proved");
        expect(task.acceptanceUnverified).toBe(false);
      }
      const reads = tree.mock.calls.length;
      expect(await invalidateAcceptance(task, task.testedVersions)).toEqual(task.testedVersions);
      expect(await acceptanceVersion(task, task.testedVersions)).toBe(task.testedPatch);
      expect(tree).toHaveBeenCalledTimes(reads);
    } finally { turn.mockRestore(); tree.mockRestore(); save.mockRestore(); await engine.shutdown(); }
  });

  it("routes check and final acceptance failures to a build-result role and retains its PR context", async () => {
    const { engine, task } = await fixture("result-routing");
    const repository = task.repositories![0]!;
    delete task.repositories;
    task.repository = repository;
    repository.branch = "main";
    repository.delivery = "pull-request";
    repository.report = { summary: "Existing build", changes: [], title: "Custom builder title", description: "The custom builder's saved PR description" };
    const builder = { ...engine.role("builder")!, id: "implementer", name: "Implementer" };
    const tester = { ...engine.role("tester")!, id: "acceptance-specialist", name: "Acceptance specialist" };
    engine.s.roles.push(builder, tester);
    const build = { id: "build", title: "Implement", kind: "do" as const, roleId: builder.id, profileIds: ["sol-high"] };
    const test = { id: "test", title: "Test", kind: "do" as const, roleId: tester.id, profileIds: ["sol-high"] };
    task.plan = { rationale: "Custom result contracts", plannerProfileId: "sol-high", stages: [build, test, { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] }] };
    task.brief = { summary: "The task", forUsers: [], areas: [], risks: [], acceptance: [{ text: "The product works" }] };
    const scope = executionFor(task);
    task.stageIndex = 2;
    expect(engine["checks"].backToBuilder(scope, "before testing")).toBe(true);
    expect(task.stageIndex).toBe(0);
    expect(repository.checkReturns).toBe(1);
    expect(engine["updates"].message(scope)).toContain("Implementer on Codex");
    expect(engine["context"]["report"](scope, builder.id)).toContainEqual({ title: "The pull request description you wrote last time", body: repository.report.description! });
    task.stageIndex = 1;
    task.retest = true;
    const turn = spyOn(engine["turns"], "turn").mockImplementation(async (_scope, _role, _profile, _given, schema) =>
      schema.parse({ summary: "A confirmed acceptance failure", checks: [{ text: "The product works", result: "fail", evidence: "Reproduced the broken behavior" }], learnings: [] }));
    try {
      expect(await engine["work"].runDo(scope, test, new AbortController().signal)).toBe("continue");
      expect(task.stageIndex).toBe(0);
      expect(task.fixing).toBe(true);
      expect(repository.acceptanceReturns).toBe(1);
      expect(task.findings.some(finding => finding.text.includes("Failed acceptance check") && finding.status === "open")).toBe(true);
      task.stageIndex = 2;
      repository.shipping = { moves: 0, failures: 0 };
      expect(await engine["shipping"]["preparationFailed"](scope, "Version checks failed", new AbortController().signal)).toBe("continue");
      expect(task.stageIndex).toBe(0);
      expect(task.fixing).toBe(true);
    } finally { turn.mockRestore(); await engine.shutdown(); }
  });

  it("schedules a renamed tester's final pass once and reuses the verified version at delivery", async () => {
    const { engine, task } = await fixture("custom-final-tester");
    const repository = task.repositories![0]!;
    delete task.repositories;
    task.repository = repository;
    const tester = { ...engine.role("tester")!, id: "acceptance-specialist", name: "Acceptance specialist" };
    engine.s.roles.push(tester);
    task.plan = { rationale: "Test final code", plannerProfileId: "sol-high", stages: [
      { id: "test", title: "Acceptance", kind: "do", roleId: tester.id, profileIds: ["sol-high"] },
      { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
    ] };
    task.stageIndex = 0;
    task.testedPatch = "earlier-version";
    task.acceptancePassed = true;
    task.state = "running";
    engine.s.pool.paused = false;
    engine.draining = false;
    const updated = spyOn(engine["updates"], "upToDate").mockResolvedValue("current");
    const checks = spyOn(engine["checks"], "checksBeforeDelivery").mockResolvedValue("passed");
    const version = spyOn(engine["checks"], "acceptanceVersion").mockResolvedValue("final-version");
    const reserve = engine["driver"]["reserveAgent"];
    engine["driver"]["reserveAgent"] = () => true;
    const work = spyOn(engine["work"], "runDo").mockImplementation(async (_scope, stage) => {
      expect(stage.roleId).toBe(tester.id);
      expect(task.retest).toBe(true);
      task.testedPatch = "final-version";
      delete task.retest;
      task.stageIndex = 1;
      return "continue";
    });
    try {
      await engine["driver"]["drive"](task.id, true);
      expect(task.error).toBeUndefined();
      expect(engine.taskDetails(task.id)!.state).toBe("needs-you");
      expect(work).toHaveBeenCalledTimes(1);
      expect(engine.s.inbox.some(item => item.taskId === task.id && item.kind === "delivery")).toBe(true);
    } finally { work.mockRestore(); engine["driver"]["reserveAgent"] = reserve; version.mockRestore(); checks.mockRestore(); updated.mockRestore(); await engine.shutdown(); }
  });

  for (const changed of [false, true]) it(`reuses captured tree and commit message for hooks${changed ? " when the hook changes during its run" : ", keeping message files inside the task diagnostics folder"}`, async () => {
    const { engine, task } = await fixture(`captured-hook-inputs-${changed}`);
    const scope = executionFor(task), path = scope.work.worktree!, base = await git(path, "rev-parse", "HEAD");
    writeFileSync(join(path, "hooked.txt"), "A product change\n");
    await git(path, "add", "."); await git(path, "commit", "-qm", "The checked commit message");
    scope.work.baseSha = base; scope.work.branch = "main";
    const hook = join(path, ".git", "hooks", "commit-msg"), recorded = join(engine.dataDir, "hook-message-path"), body = join(engine.dataDir, "hook-message-body");
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$1" > ${quote(recorded)}\ncat "$1" > ${quote(body)}\n${changed ? `printf '# Changed hook definition\\n' >> "$0"\n` : ""}`, { mode: 0o755 });
    const messages = spyOn(gitOps, "message");
    const state = await engine["checks"]["captureState"](scope, []);
    const heads = spyOn(gitOps, "head"), trees = spyOn(gitOps, "treeOf");
    try {
      engine.setPoolPaused(false);
      expect(state.message).toBe("The checked commit message");
      expect(await engine["checks"].runProductChecks(scope, [], new AbortController().signal, undefined, state)).toBe(0);
      expect(messages).toHaveBeenCalledTimes(1);
      expect(heads).not.toHaveBeenCalled(); expect(trees).not.toHaveBeenCalled();
      expect(readFileSync(body, "utf8")).toBe("The checked commit message\n");
      const messagePath = readFileSync(recorded, "utf8");
      expect(dirname(dirname(messagePath))).toBe(join(engine.dataDir, "checks", task.id));
      expect(existsSync(messagePath)).toBe(false);
      expect(scope.work.checks).toMatchObject({ current: !changed, sha: state.sha, tree: state.tree });
      expect(task.journey!.at(-1)!.checkAttempts![0]).toMatchObject({ passed: !changed, sha: state.sha, tree: state.tree, definition: state.definition });
    } finally { messages.mockRestore(); heads.mockRestore(); trees.mockRestore(); await engine.shutdown(); }
  });

  it("pins reusable check tree and hook-message inputs to the observed commit", async () => {
    const { engine, task } = await fixture("pinned-check-snapshot");
    const scope = executionFor(task), path = scope.work.worktree!, before = await git(path, "rev-parse", "HEAD"), tree = await git(path, "rev-parse", "HEAD^{tree}"), message = await git(path, "log", "-1", "--format=%B");
    writeFileSync(join(path, ".git", "hooks", "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const status = gitOps.worktreeStatus;
    const read = spyOn(gitOps, "worktreeStatus").mockImplementation(async file => {
      const observed = await status(file);
      writeFileSync(join(path, "moved-head.txt"), "HEAD moved after the status observation\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "A later commit");
      return observed;
    });
    try {
      const captured = await engine["checks"]["captureState"](scope, []);
      expect(await git(path, "rev-parse", "HEAD")).not.toBe(before);
      expect(captured).toMatchObject({ sha: before, tree, message });
    } finally { read.mockRestore(); await engine.shutdown(); }
  });

  for (const current of [false, true]) it(`keeps check evidence ${current ? "honest after an agent commits its own edits" : "stale without re-reading an unchanged tree"}`, async () => {
    const { engine, task } = await fixture(`save-role-evidence-${current}`);
    const scope = executionFor(task), path = scope.work.worktree!;
    scope.work.checks = { current, at: 1, tree: await git(path, "rev-parse", "HEAD^{tree}"), results: [] };
    if (current) {
      writeFileSync(join(path, "agent-commit.txt"), "Committed by the agent before handoff\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "Agent's own commit");
    }
    const trees = spyOn(gitOps, "treeOf");
    try {
      await engine.saveRoleEdits(scope, "builder", "sol-high");
      expect(scope.work.checks.current).toBe(false);
      expect(trees).toHaveBeenCalledTimes(current ? 1 : 0);
    } finally { trees.mockRestore(); await engine.shutdown(); }
  });

  it("retains all hand-back snapshot anchors after a partial advance, then checks both products on retry", async () => {
    const { engine, task } = await fixture("partial-shared-handback");
    const anchors: Record<string, { path: string; head: string }> = {};
    for (const work of task.repositories!) {
      const root = work.worktree!, head = await git(root, "rev-parse", "HEAD"), copy = join(engine.dataDir, work.productId + "-snapshot");
      work.branch = "main"; work.baseSha = head;
      work.source = { product: { ...engine.s.products.find(product => product.id === work.productId)!, path: root }, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: "local/fixture", branch: "main" }, confirmed: true };
      work.checks = { current: true, at: 1, tree: await git(root, "rev-parse", "HEAD^{tree}"), results: [] };
      await gitOps.addCopy(root, copy, head);
      writeFileSync(join(copy, "hand-edited.txt"), work.productId + " edit\n");
      anchors[work.productId] = { path: copy, head };
    }
    task.driving = { roleId: "builder", profileId: "sol-high", toolId: "codex", head: anchors.first!.head, since: Date.now(), repositoryCopies: structuredClone(anchors) };
    const move = gitOps.moveTo;
    let fail = true;
    const moves = spyOn(gitOps, "moveTo").mockImplementation(async (path, sha) => {
      if (path === task.repositories![1]!.worktree && fail) throw new Error("Second product could not advance");
      return move(path, sha);
    });
    const start = engine.startDriver; engine.startDriver = () => {};
    try {
      await expectRejection(engine.handBack(task.id, "Keep the edits", true), "Second product could not advance");
      expect(task.driving!.repositoryCopies).toEqual(anchors);
      expect(existsSync(join(task.repositories![0]!.worktree!, "hand-edited.txt"))).toBe(true);
      expect(task.repositories![0]!.checks!.current).toBe(false);
      fail = false;
      await engine.handBack(task.id, "Keep the edits", true);
      expect(task.driving).toBeUndefined();
      for (const work of task.repositories!) {
        expect(readFileSync(join(work.worktree!, "hand-edited.txt"), "utf8")).toBe(work.productId + " edit\n");
        expect(work.tamper?.sha).toBe(await git(work.worktree!, "rev-parse", "HEAD"));
        expect(work.checks!.current).toBe(false);
      }
    } finally { moves.mockRestore(); engine.startDriver = start; await engine.shutdown(); }
  });

  it("persists cached archive edits before eviction and keeps live projections light with independent revisions", async () => {
    const { engine, task } = await fixture("projection-eviction");
    const ids = Array.from({ length: 20 }, (_, index) => engine.addTask({ productId: "first", title: `Archive ${index}`, backlog: true }));
    for (const id of ids) engine.cancel(id);
    engine.save();
    const first = engine.task(ids[0]!)!;
    first.statusLine = "Updated while archived";
    engine.commit(first);
    for (const id of ids.slice(1)) expect(engine.taskDetails(id)).toBeDefined();
    const reopened = engine.task(ids[0]!)!;
    expect(reopened).not.toBe(first);
    expect(reopened.statusLine).toBe("Updated while archived");
    task.session = [{ id: "large", at: 1, from: "agent", text: "Conversation ".repeat(1000) }];
    const all = spyOn(engine.store.history, "all").mockImplementation(() => { throw new Error("Live projection must not load archive bodies"); });
    try {
      const before = engine.windowState().tasks.find(entry => entry.id === task.id)!;
      task.todo = "A new to-do item"; engine.commit(task);
      const after = engine.windowState().tasks.find(entry => entry.id === task.id)!;
      expect(after.detailsRevision).not.toBe(before.detailsRevision);
      expect(after.session).toEqual([]);
      expect(engine.taskDetails(task.id)!.session).toHaveLength(1);
      expect(engine.historyPage({}).total).toBe(20);
      expect(all).not.toHaveBeenCalled();
    } finally { all.mockRestore(); await engine.shutdown(); }
  });

  it("enumerates canonical owners in approved order, opting into excluded owners without inventing an empty scope", async () => {
    const { engine, task } = await fixture("all-scopes");
    try {
      const [first, second] = task.repositories!;
      task.activeProductId = second!.productId;
      const excluded = { ...second!, productId: "excluded" };
      task.excludedRepositories = [excluded];
      expect(scopesFor(task).map(scope => scope.work)).toEqual([first!, second!]);
      expect(scopesFor(task)[0]!.work).toBe(first!);
      expect(scopesFor(task, { includeExcluded: true }).at(-1)!.work).toBe(excluded);
      expect(task.activeProductId).toBe(second!.productId);
      task.repositories = [];
      expect(scopesFor(task)).toEqual([]);
      delete task.repositories;
      task.repository = first!;
      expect(scopesFor(task)).toEqual([{ task, work: first! }]);
      expect(scopesFor(task)[0]!.work).toBe(first!);
    } finally { await engine.shutdown(); }
  });

  for (const hooks of [false, true]) it(`restores checks with one combined inspection${hooks ? " and verifies a hook's reverted commit" : ", retaining untracked build output"}`, async () => {
    const { engine, task } = await fixture(`post-check-${hooks}`);
    const scope = executionFor(task, "first"), path = scope.work.worktree!;
    const sha = await git(path, "rev-parse", "HEAD"), tree = await git(path, "rev-parse", "HEAD^{tree}");
    const original = await git(path, "show", "HEAD:README.md");
    const inspections = spyOn(gitOps, "worktreeStatus"), heads = spyOn(gitOps, "head");
    const checks = engine["checks"], hook = checks["runHooks"];
    checks["runHooks"] = async () => {
      if (hooks) {
        writeFileSync(join(path, "README.md"), "A hook changed the product\n");
        await git(path, "add", "."); await git(path, "commit", "-qm", "An unapproved hook commit");
      }
      return [];
    };
    // A run with nothing to run touches no file at all; a real check gets exactly one combined inspection afterwards.
    const checksToRun = hooks ? [] : [{ name: "Build", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('check-artifact.txt', 'Build output\\n')"] }];
    try {
      expect(await engine["checks"]["runAll"](scope, checksToRun, { sha, tree, trackedChanged: false, hooks: hooks ? ["pre-commit"] : [], definition: "test" }, new AbortController().signal, new Map())).toBe(0);
      expect(heads).not.toHaveBeenCalled();
      expect(inspections).toHaveBeenCalledTimes(hooks ? 3 : 1);
      expect(scope.work.checks).toMatchObject({ current: true, sha, tree, results: hooks ? [] : [expect.objectContaining({ name: "Build", ok: true })] });
      expect(await git(path, "rev-parse", "HEAD")).toBe(sha);
      expect(await git(path, "show", "HEAD:README.md")).toBe(original);
      if (!hooks) expect(await git(path, "status", "--porcelain")).toContain("check-artifact.txt");
    } finally { checks["runHooks"] = hook; heads.mockRestore(); inspections.mockRestore(); await engine.shutdown(); }
  });

  it("does not attach current check evidence to the old commit when restoring a hook's commit fails", async () => {
    const { engine, task } = await fixture("failed-post-check-restore");
    const scope = executionFor(task, "first"), path = scope.work.worktree!, sha = await git(path, "rev-parse", "HEAD");
    scope.work.checks = { at: 1, current: true, sha, results: [] };
    const checks = engine["checks"], hook = checks["runHooks"];
    checks["runHooks"] = async () => {
      writeFileSync(join(path, "README.md"), "A hook commit that cannot be reverted\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "Unexpected commit");
      return [];
    };
    const reset = spyOn(gitOps, "resetTo").mockResolvedValue(undefined);
    try {
      await expectRejection(engine["checks"]["runAll"](scope, [], { sha, trackedChanged: false, hooks: ["pre-commit"], definition: "test" }, new AbortController().signal, new Map()), "could not restore the original work");
      expect(scope.work.checks).toMatchObject({ sha, current: false });
      expect(await git(path, "rev-parse", "HEAD")).not.toBe(sha);
    } finally { reset.mockRestore(); checks["runHooks"] = hook; await engine.shutdown(); }
  });

  for (const variant of ["unchanged", "changed commit", "moved source", "failed checks"] as const) it(`keeps delivery approval and checks authoritative: ${variant}`, async () => {
    const { engine, task } = await fixture(`approval-${variant.replaceAll(" ", "-")}`);
    const scope = executionFor(task, "first"), sha = await git(scope.work.worktree!, "rev-parse", "HEAD");
    scope.work.approvedSha = sha; scope.work.approvedPatch = "approved-patch";
    task.plan = { rationale: "Approval test", plannerProfileId: "sol-high", stages: [
      { id: "delivery-check", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
      { id: "delivery", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 1;
    const shipping = engine["shipping"], back = shipping["backToWork"];
    shipping["backToWork"] = async () => {};
    const update = spyOn(engine["updates"], "upToDate").mockResolvedValue(variant === "moved source" ? "moved" : "current");
    const head = spyOn(gitOps, "head").mockResolvedValue(variant === "changed commit" ? "a".repeat(40) : sha);
    const patch = spyOn(engine["updates"], "patch").mockResolvedValue("different-patch");
    const checks = spyOn(engine["checks"], "checksBeforeShipping").mockResolvedValue(variant === "failed checks");
    try {
      const changed = variant === "changed commit" || variant === "moved source";
      expect(await engine["shipping"]["readyToShip"](scope, new AbortController().signal)).toBe(variant === "unchanged" ? "ready" : "back");
      expect(patch).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(checks).toHaveBeenCalledTimes(changed ? 0 : 1);
      if (changed) { expect(task.stageIndex).toBe(0); expect(scope.work.approvedSha).toBeUndefined(); }
    } finally { checks.mockRestore(); patch.mockRestore(); head.mockRestore(); update.mockRestore(); shipping["backToWork"] = back; await engine.shutdown(); }
  });

  it("inspects hand changes across products concurrently and records every result in product order", async () => {
    const { engine, task } = await fixture("hand-change-reads");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    const checks: { path: string; resolve: (problems: string[]) => void }[] = [], heads: { path: string; resolve: (sha: string) => void }[] = [];
    const check = spyOn(gitOps, "tamperCheck").mockImplementation((path) => new Promise((resolve) => checks.push({ path, resolve })));
    const head = spyOn(gitOps, "head").mockImplementation((path) => new Promise((resolve) => heads.push({ path, resolve })));
    let pending: Promise<void> | undefined;
    try {
      task.plan = { rationale: "Review hand changes", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"] }] };
      task.stageIndex = 0;
      const products = ["second", "first"], paths = products.map((id) => executionFor(task, id).work.worktree!);
      pending = engine["takeover"]["reviewHandChanges"](task, products);
      expect(checks.map((read) => read.path)).toEqual(paths);
      expect(heads.map((read) => read.path)).toEqual(paths);
      checks[1]!.resolve(["A test was removed"]); heads[1]!.resolve("a".repeat(40));
      await Promise.resolve();
      expect(task.findings).toEqual([]);
      checks[0]!.resolve(["A test was skipped"]); heads[0]!.resolve("b".repeat(40));
      await pending;
      expect(task.findings.map((finding) => [finding.text, finding.productIds])).toEqual([["A test was skipped", ["second"]], ["A test was removed", ["first"]]]);
      expect(executionFor(task, "first").work.tamper?.sha).toBe("a".repeat(40));
      expect(executionFor(task, "second").work.tamper?.sha).toBe("b".repeat(40));
      expect(task.handChanges).toBe(true);
      expect(task.rereview).toBe("review");
    } finally {
      for (const read of checks) read.resolve([]); for (const read of heads) read.resolve("a".repeat(40));
      await pending?.catch(() => {}); check.mockRestore(); head.mockRestore(); await engine.shutdown();
    }
  });

  it("clears temporary release preparation after version, history or notes failures", async () => {
    const { engine, task } = await fixture("release-preview-interruption");
    const scope = executionFor(task), releases = engine["shipping"]["releases"];
    scope.work.delivery = "release"; scope.work.baseSha = await git(scope.work.worktree!, "rev-parse", "HEAD");
    const stage = { id: "delivery", title: "Delivery", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: ["sol-high"] };
    const choose = spyOn(releases, "chooseVersion").mockImplementation(async () => { Object.assign(scope.work.shipping!, { version: "1.0.0", tag: "v1.0.0", after: "" }); return []; });
    const history = spyOn(releases, "sincePreviousRelease").mockResolvedValue({ title: "History", body: "A change" });
    const turn = spyOn(engine["turns"], "turn").mockResolvedValue({ notes: "Notes", summary: "Summary" });
    try {
      for (const fail of [choose, history, turn]) {
        fail.mockRejectedValueOnce(new Error("Interrupted preview"));
        await expectRejection(releases.previewRelease(scope, stage, new AbortController().signal), "Interrupted preview");
        expect(scope.work.shipping).toBeUndefined();
        expect(scope.work.releasePreview).toBeUndefined();
        engine.commitNow();
        expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.repositories![0]!.shipping).toBeUndefined();
      }
      await releases.previewRelease(scope, stage, new AbortController().signal);
      expect(scope.work.shipping).toBeUndefined();
      expect(scope.work.releasePreview).toMatchObject({ version: "1.0.0", notes: "Notes" });
    } finally { choose.mockRestore(); history.mockRestore(); turn.mockRestore(); await engine.shutdown(); }
  });

  it("reuses original version contents and reads each committed target once while validating a release", async () => {
    const { engine, task } = await fixture("release-version-reads");
    const scope = executionFor(task, "first"), path = scope.work.worktree!;
    const files = [
      { file: "package.json", text: '{"name":"demo","version":"1.0.0"}\n', version: "1.0.0" },
      { file: "Cargo.toml", text: '[package]\nname = "demo"\nversion = "1.0.0"\n', version: "1.0.0" },
    ];
    const lock = 'version = 3\n\n[[package]]\nname = "demo"\nversion = "1.0.0"\n';
    for (const file of files) writeFileSync(join(path, file.file), file.text);
    writeFileSync(join(path, "Cargo.lock"), lock);
    await git(path, "add", "."); await git(path, "commit", "-qm", "Record version files");
    const start = await git(path, "rev-parse", "HEAD");
    scope.work.shipping = { start, version: "1.0.1", tag: "v1.0.1", moves: 0, failures: 0 };
    const read = spyOn(gitOps, "fileAt");
    try {
      const tested = await engine["shipping"]["releases"]["setVersion"](scope, files);
      expect(tested).not.toBe(start);
      expect(scope.work.savedVersion).toEqual({ commit: tested, tree: await git(path, "rev-parse", "HEAD^{tree}") });
      for (const file of files) {
        expect(read.mock.calls.filter(([, sha, name]) => sha === start && name === file.file)).toHaveLength(0);
        expect(read.mock.calls.filter(([, sha, name]) => sha === tested && name === file.file)).toHaveLength(1);
        expect(await git(path, "show", `${tested}:${file.file}`)).toContain("1.0.1");
      }
      expect(read.mock.calls.filter(([, sha, name]) => sha === start && name === "Cargo.lock")).toHaveLength(1);
      expect(read.mock.calls.filter(([, sha, name]) => sha === tested && name === "Cargo.lock")).toHaveLength(1);
      expect(await git(path, "show", `${tested}:Cargo.lock`)).toContain('version = "1.0.1"');
      expect((await git(path, "diff", "--name-only", start, tested)).split("\n").sort()).toEqual(["Cargo.lock", "Cargo.toml", "package.json"]);
    } finally { read.mockRestore(); await engine.shutdown(); }
  });

  it("reads shared PR states concurrently and ignores late replies after a driver starts", async () => {
    const { engine, task } = await fixture("parallel-pr-reads");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    task.state = "pr-open";
    for (const [index, work] of task.repositories!.entries()) {
      const product = engine.s.products.find((product) => product.id === work.productId)!;
      work.source = { product, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", repo: product.repo, branch: "main", kind: "new-pr" } };
      work.pr = { number: index + 1, url: "https://example.test/pr", state: "open", openedAt: 1 };
    }
    let closing = false, pending: Promise<void> | undefined;
    const replies: ((value: Awaited<ReturnType<typeof github.prState>>) => void)[] = [];
    const read = spyOn(github, "prState").mockImplementation(() => closing ? Promise.resolve("open") : new Promise((resolve) => replies.push(resolve)));
    try {
      pending = engine["shipping"].monitor.pollPullRequests();
      expect(replies).toHaveLength(2);
      engine.drivers.set(task.id, new AbortController());
      replies[0]!("merged"); replies[1]!("closed");
      await pending;
      expect(task.repositories!.map((work) => work.pr!.state)).toEqual(["open", "open"]);
      expect(task.state as string).toBe("pr-open");
    } finally {
      closing = true; for (const reply of replies) reply("open");
      await pending?.catch(() => {}); engine.drivers.delete(task.id); read.mockRestore(); await engine.shutdown();
    }
  });

  it("observes check inputs once per gate and rechecks freshness instead of trusting a saved current flag", async () => {
    const { engine, task } = await fixture("check-observations");
    const probe = spyOn(gitOps, "worktreeStatus");
    try {
      engine.setPoolPaused(false);
      const scope = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      const commands = [{ name: "Quick check", argv: [process.execPath, "-e", "console.log('Checked')"] }];
      engine.s.products.find((product) => product.id === "first")!.checks = commands;
      expect(await checks.failing(scope, signal, commands)).toBe(false);
      // One gate observation plus one combined inspection after the command.
      expect(probe).toHaveBeenCalledTimes(2);
      const attempt = task.journey!.at(-1)!.checkAttempts![0]!;
      expect(attempt).toMatchObject({ passed: true, sha: scope.work.checks!.sha, tree: scope.work.checks!.tree, definition: scope.work.checks!.definition });
      expect(await checks.failing(scope, signal, commands)).toBe(false);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(task.journey!.at(-1)!.checkAttempts).toHaveLength(1);
      expect(scope.work.checks!.current).toBe(true);
      writeFileSync(join(scope.work.worktree!, "README.md"), "A tracked change after the checks\n");
      expect(await checks.current(scope)).toBe(false);
      expect(probe).toHaveBeenCalledTimes(4);
      expect(attempt.passed).toBe(true);
    } finally { probe.mockRestore(); await engine.shutdown(); }
  });

  it("keeps bound owners and canonical state through snapshots, saves and restart", async () => {
    const f = await fixture("snapshots");
    let engine = f.engine;
    try {
      const first = executionFor(f.task, "first"), second = executionFor(f.task, "second");
      first.work.checkReturns = 1;
      f.task.activeProductId = "second";
      const before = JSON.stringify(f.task);
      expect(engine.activeState().tasks.find((task) => task.id === f.id)!.worktree).toBeUndefined();
      expect(engine.getState().tasks.find((task) => task.id === f.id)!.worktree).toBe(second.work.worktree);
      expect(engine.windowState().tasks.find((task) => task.id === f.id)!.report?.summary).toBe("second report");
      expect(engine.taskDetails(f.id)!.builderSession?.sessionId).toBe("second-conversation");
      expect(JSON.stringify(f.task)).toBe(before);
      first.work.report!.summary = "First finished while the second product was selected";
      engine.commitNow();
      const saved = engine.store.load()!.tasks.find((task) => task.id === f.id)!;
      expect(saved.worktree).toBeUndefined();
      expect(saved.report).toBeUndefined();
      expect(saved.repositories!.map((work) => work.report!.summary)).toEqual([first.work.report!.summary, "second report"]);
      expect(() => executionFor(f.task, "outside")).toThrow("outside the approved task");
      await engine.shutdown();
      engine = f.start();
      const task = engine.task(f.id)!;
      expect(Object.hasOwn(task, "worktree")).toBe(false);
      expect(Object.hasOwn(task, "builderSession")).toBe(false);
      expect(task.repositories!.map((work) => work.builderSession!.sessionId)).toEqual(["first-conversation", "second-conversation"]);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([1, undefined]);
      expect(engine.taskDetails(f.id)!.branch).toBe("task-second");
    } finally { await engine.shutdown(); }
  });

  it("finishes a queued check against its bound owner after the task's current product changes", async () => {
    const { engine, task } = await fixture("queued-check");
    let release: (() => void) | undefined;
    let pending: Promise<number> | undefined;
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"];
      const signal = new AbortController().signal;
      release = await checks["turnToRun"](second, signal);
      pending = checks.runProductChecks(first, [{ name: "First product only", argv: [process.execPath, "-e", "console.error('Failure from the first product'); process.exit(1)"] }], signal);
      await waitFor(() => engine.checkQueue.waiting === 1, "the first product's check to queue");
      writeFileSync(join(first.work.worktree!, "queued-change.txt"), "Committed while checks waited\n");
      await git(first.work.worktree!, "add", "."); await git(first.work.worktree!, "commit", "-qm", "Keep the change made while checks waited");
      const queuedHead = await gitOps.head(first.work.worktree!);
      const hook = join(first.work.worktree!, ".git", "hooks", "commit-msg");
      writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o755);
      task.activeProductId = "second";
      engine.getState(); engine.windowState(); engine.taskDetails(task.id); engine.commitNow();
      release(); release = undefined;
      expect(await pending).toBe(1);
      expect(await gitOps.head(first.work.worktree!)).toBe(queuedHead);
      expect(engine.s.products.find((product) => product.id === "first")!.hooks).toEqual(["commit-msg"]);
      expect(first.work.checks!.results[0]!.output).toContain("Failure from the first product");
      expect(second.work.checks).toBeUndefined();
      expect(Object.hasOwn(task, "checks")).toBe(false);
      expect(task.findings.filter((finding) => finding.raisedBy === "petrina").map((finding) => finding.productIds)).toEqual([["first"]]);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).length).toBeGreaterThan(0);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).every((line) => line.productId === "first")).toBe(true);
      expect(engine.taskDetails(task.id)!.checks).toBeUndefined();
      engine.save();
      expect(engine.store.load()!.tasks.find((entry) => entry.id === task.id)!.repositories![0]!.checks!.results[0]!.ok).toBe(false);
    } finally { release?.(); await pending?.catch(() => {}); await engine.shutdown(); }
  });

  it("cleans each included and excluded repository's review copies once using its own clone", async () => {
    const { engine, task } = await fixture("cleanup-roots");
    try {
      await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
      task.state = "cancelled";
      task.excludedRepositories = [{ ...structuredClone(task.repositories![0]!), productId: "excluded" }];
      const works = [...task.repositories!, ...task.excludedRepositories];
      for (const work of works) {
        const product = engine.s.products.find((product) => product.id === work.productId) ?? engine.s.products[0]!;
        work.source = { product: { ...product, id: work.productId }, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: product.repo, branch: "main", kind: "branch" } };
        work.worktree = join(engine.dataDir, "worktrees", work.productId, task.id);
      }
      const copies = spyOn(gitOps, "removeFinishedCopies").mockResolvedValue(true);
      const main = spyOn(gitOps, "removeWorktree").mockResolvedValue(true);
      try {
        await new Cleanup(engine).removeCopy(task.id);
        expect(copies.mock.calls).toEqual(works.map((work) => [work.source!.product.path!, join(engine.dataDir, "worktrees", work.productId, `${task.id}.copies`), engine.files]));
        expect(main.mock.calls).toEqual(works.map((work) => [work.source!.product.path!, work.worktree!, engine.files]));
        expect(works.every((work) => work.cleanup?.reviewCopiesRemovedAt !== undefined)).toBe(true);
        const times = works.map(work => ({ ...work.cleanup }));
        copies.mockClear(); main.mockClear();
        const commit = spyOn(engine, "commitNow"), archive = spyOn(engine, "saveArchivedTask");
        try {
          await new Cleanup(engine).removeCopy(task.id, true);
          expect(copies).not.toHaveBeenCalled(); expect(main).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
          expect(works.map(work => work.cleanup)).toEqual(times);
        } finally { commit.mockRestore(); archive.mockRestore(); }
      } finally { copies.mockRestore(); main.mockRestore(); }
    } finally { await engine.shutdown(); }
  });

  it("continues shared cleanup after a missing source or failed save, logging each repository failure once", async () => {
    const { engine, task } = await fixture("cleanup-missing-source");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    task.state = "cancelled";
    const [first, second] = task.repositories!;
    const extra = { ...structuredClone(first!), productId: "excluded" };
    task.excludedRepositories = [extra];
    const works = [first!, second!, extra];
    for (const work of works) work.worktree = join(engine.dataDir, "worktrees", work.productId, task.id);
    delete engine.s.products.find(product => product.id === "second")!.path;
    extra.source = { product: { ...engine.s.products[0]!, id: extra.productId }, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: "acme/first", branch: "main", kind: "branch" } };
    const clone = spyOn(gitOps, "mainClone").mockResolvedValue(undefined);
    const copies = spyOn(gitOps, "removeFinishedCopies").mockResolvedValue(true);
    const main = spyOn(gitOps, "removeWorktree").mockResolvedValue(true);
    const save = spyOn(engine, "commitNow").mockImplementationOnce(() => { throw new Error("Disk full"); });
    try {
      const cleanup = new Cleanup(engine);
      await cleanup.removeCopy(task.id, true);
      expect(copies).toHaveBeenCalledTimes(2); expect(main).toHaveBeenCalledTimes(2);
      expect(first!.cleanup?.removedAt).toBeDefined(); expect(extra.cleanup?.removedAt).toBeDefined();
      expect(second!.cleanup?.error).toBe("the product's repository could not be found");
      expect(task.timeline.filter(line => line.tone === "warn" && line.productId === "second")).toHaveLength(1);
      copies.mockClear(); main.mockClear();
      await cleanup.removeCopy(task.id, true);
      expect(copies).not.toHaveBeenCalled(); expect(main).not.toHaveBeenCalled();
      expect(task.timeline.filter(line => line.tone === "warn" && line.productId === "second")).toHaveLength(1);
    } finally { clone.mockRestore(); copies.mockRestore(); main.mockRestore(); save.mockRestore(); await engine.shutdown(); }
  });

  it("groups a shared reviewer's companion lessons and reads only their repository once", async () => {
    const { engine, task } = await fixture("named-learning");
    const read = spyOn(gitOps, "fileAt");
    try {
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const learnings = new Learnings(engine);
      const texts = ["Use the second product's focused check for its UI changes.", "The second product's fixtures live beside its tests."];
      await learnings.note(first, [...texts.map((text) => ({ productId: "second", text })), { productId: "second", text: texts[0]! }, "An unassigned shared lesson stays with the task."], "code-reviewer", "sol-high");
      expect(first.work.lessons).toBeUndefined();
      expect(second.work.lessons?.map((lesson) => lesson.text)).toEqual(texts);
      expect(task.sharedLessons?.map((lesson) => lesson.text)).toEqual(["An unassigned shared lesson stays with the task."]);
      expect(read.mock.calls.filter(([, , file]) => file === "AGENTS.md")).toEqual([[second.work.worktree!, "HEAD", "AGENTS.md"]]);
      expect(Object.hasOwn(task, "lessons")).toBe(false);
    } finally { read.mockRestore(); await engine.shutdown(); }
  });

  it("keeps a single repository's saved execution separate from its public task view", async () => {
    const world = await makeWorld("canonical-single"); worlds.push(world);
    const start = () => world.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    let engine = start(); engine.setPoolPaused(true);
    try {
      const productId = await engine.addProduct(world.clone);
      const id = engine.addTask({ productId, title: "One canonical execution record", backlog: true });
      const task = engine.task(id)!;
      const { work } = executionFor(task);
      work.report = { summary: "Persisted only on the repository", changes: [] };
      work.checkReturns = 2;
      engine.commitNow();
      const saved = engine.store.load()!.tasks.find((task) => task.id === id)!;
      expect(saved.report).toBeUndefined();
      expect(saved.repository!.report?.summary).toBe("Persisted only on the repository");
      expect(engine.taskDetails(id)!.repository).toBeUndefined();
      expect(engine.windowState().tasks.find((task) => task.id === id)!.report?.summary).toBe("Persisted only on the repository");
      await engine.shutdown(); engine = start();
      expect(Object.hasOwn(engine.task(id)!, "report")).toBe(false);
      expect(executionFor(engine.task(id)!).work.checkReturns).toBe(2);
      expect(engine.taskDetails(id)!.report?.summary).toBe("Persisted only on the repository");
    } finally { await engine.shutdown(); }
  });

  it("imports an existing saved cursor once without retaining another writable copy", async () => {
    const f = await fixture("saved-cursor");
    let engine = f.engine;
    try {
      f.task.activeProductId = "second";
      Object.assign(f.task, { branch: "latest-saved-second", report: { summary: "Latest second report from the previous engine", changes: [] } });
      engine.commitNow();
      await engine.shutdown();
      engine = f.start();
      const restored = engine.task(f.id)!;
      expect(Object.hasOwn(restored, "branch")).toBe(false);
      expect(Object.hasOwn(restored, "report")).toBe(false);
      expect(restored.repositories!.map((work) => work.branch)).toEqual(["task-first", "latest-saved-second"]);
      expect(restored.repositories![1]!.report!.summary).toBe("Latest second report from the previous engine");
      engine.save();
      const saved = engine.store.load()!.tasks.find((task) => task.id === f.id)!;
      expect(saved.branch).toBeUndefined();
      expect(saved.repositories![1]!.branch).toBe("latest-saved-second");
    } finally { await engine.shutdown(); }
  });
});

describe("shared check repair episodes", () => {
  const plan = () => ({ rationale: "Shared checks", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] },
    { id: "test", title: "Try it", kind: "do" as const, roleId: "tester", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
    { id: "delivery", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] },
    { id: "ship", title: "Commit to main", kind: "do" as const, roleId: "release-manager", profileIds: ["sol-high"] },
  ] });
  const command = (name: string, script: string) => ({ name, argv: [process.execPath, "-e", script] });
  const passing = command("Tests", "console.log('All tests pass')");
  const failing = command("Welcome page", "console.error('The welcome page is missing'); process.exit(1)");
  /** The checks the coordinator set for a product: the ones a pass has to cover. */
  const setChecks = (engine: Awaited<ReturnType<typeof fixture>>["engine"], productId: string, commands: readonly { name: string; argv: string[] }[]) => {
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    product.checks = [...commands];
    product.checksBy = "coordinator";
  };

  it("ends one product's failure episode on its own genuine pass, keeping the other's spent repairs", async () => {
    const { engine, task } = await fixture("check-episodes");
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      setChecks(engine, "first", [passing, failing]);
      setChecks(engine, "second", [passing]);
      first.work.checkReturns = 2;
      second.work.checkReturns = 1;
      // One check fixed while another still fails continues the episode; nothing clears or extends it.
      expect(await checks.runProductChecks(first, [passing, failing], signal)).toBe(1);
      expect(first.work.checkReturns).toBe(2);
      expect(await checks.runProductChecks(second, [passing], signal)).toBe(0);
      expect(first.work.checkReturns).toBe(2);
      expect(second.work.checkReturns).toBeUndefined();
      // Rereading a saved failure is no new attempt; a saved pass on the same code and definitions is a genuine pass.
      second.work.checkReturns = 1;
      expect(await checks.failing(first, signal)).toBe(true);
      expect(await checks.failing(second, signal)).toBe(false);
      expect(first.work.checkReturns).toBe(2);
      expect(second.work.checkReturns).toBeUndefined();
      expect(first.work.checks!.results.map((run) => run.ok)).toEqual([true, false]);
    } finally { await engine.shutdown(); }
  });

  it("keeps confirmed interrupted evidence unverified without repairing or spending either product's allowance", async () => {
    const { engine, task } = await fixture("check-interrupted");
    try {
      engine.setPoolPaused(false); task.plan = plan(); task.stageIndex = 2;
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      setChecks(engine, "first", [failing]); setChecks(engine, "second", [passing]);
      await checks.runProductChecks(first, [failing], signal);
      await checks.runProductChecks(second, [passing], signal);
      first.work.checkReturns = 2; second.work.checkReturns = 1;
      const original = first.work.checks!.results[0]!;
      original.interruption = { source: "macOS power log", at: original.startedAt!, event: "Entering Sleep state due to Clamshell Sleep" };
      expect(await checks.failing(first, signal)).toBe(true);
      expect(checks.backToBuilder(first, "before review")).toBe(false);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([2, 1]);
      expect(task.findings.filter((finding) => finding.status === "open")).toHaveLength(0);
      expect(task.findings[0]!.status).toBe("unverified");
      expect(checks.blocked(task)).toBe("stop");
      expect(task.statusLine).toBe("Checks unverified. Your call");
      const decision = task.journey!.at(-1)!;
      expect(decision.productChecks!.map((check) => [check.productId, check.result])).toEqual([["first", "stopped"], ["second", "pass"]]);
      expect(decision.productChecks![0]!.run!.output).toBe(original.output);
      expect(decision.productChecks![0]!.run!.source).toEqual(original.source);
    } finally { await engine.shutdown(); }
  });

  it("recovers recorded sleep for an already waiting decision and preserves its original run across restart", async () => {
    const f = await fixture("check-interruption-recovery", async () => "2026-10-21 17:55:44 +0300 Sleep Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 74 secs");
    let engine = f.engine;
    try {
      engine.setPoolPaused(false); f.task.plan = plan(); f.task.stageIndex = 2;
      const scope = executionFor(f.task, "first");
      setChecks(engine, "first", [failing]);
      await engine["checks"].runProductChecks(scope, [failing], new AbortController().signal);
      const run = scope.work.checks!.results[0]!;
      run.startedAt = Date.parse("2026-10-21T17:54:07+03:00"); run.endedAt = Date.parse("2026-10-21T17:57:46+03:00"); run.ms = run.endedAt - run.startedAt;
      const original = f.task.journey!.find((step) => step.id === run.source!.stepId)!;
      original.startedAt = run.startedAt; original.endedAt = run.endedAt;
      original.productChecks![0]!.run = { ...run };
      original.productChecks![0]!.startedAt = run.startedAt; original.productChecks![0]!.endedAt = run.endedAt;
      const outcome = original.outcome, output = run.output, source = { ...run.source! };
      scope.work.checkReturns = 2;
      engine["checks"].blocked(f.task);
      const count = f.task.journey!.length;
      await engine["checks"].restoreEvidence();
      expect(f.task.statusLine).toBe("Checks unverified. Your call");
      expect(f.task.journey).toHaveLength(count);
      expect(original.outcome).toBe(outcome);
      expect(original.productChecks![0]!.result).toBe("fail");
      expect(original.productChecks![0]!.run!.interruption?.source).toBe("macOS power log");
      expect(f.task.journey!.at(-1)!.productChecks![0]!.result).toBe("stopped");
      expect(f.task.findings[0]!.status).toBe("unverified");
      expect(scope.work.checkReturns).toBe(2);
      expect(f.task.repair).toBeUndefined();
      await engine.shutdown(); engine = f.start();
      const restored = engine.task(f.id)!;
      const saved = executionFor(restored, "first").work.checks!.results[0]!;
      expect(saved).toEqual(expect.objectContaining({ output, source, interruption: expect.objectContaining({ source: "macOS power log" }) }));
      expect(restored.statusLine).toBe("Checks unverified. Your call");
      expect(executionFor(restored, "first").work.checkReturns).toBe(2);
    } finally { await engine.shutdown(); }
  });

  it("requests fresh checks only for unfinished products without approving or replenishing repairs", async () => {
    const { engine, task } = await fixture("check-explicit-partial");
    try {
      task.plan = plan(); task.stageIndex = 2;
      const first = executionFor(task, "first").work, second = executionFor(task, "second").work;
      first.landed = { branch: "main", sha: "delivered" };
      first.checks = { at: 1, current: true, sha: "delivered", tree: "first-tree", results: [{ name: "Tests", command: "tests", ok: true, ms: 1, output: "Passed" }] };
      second.checks = { at: 2, current: true, sha: "pending", tree: "second-tree", results: [{ name: "Tests", command: "tests", ok: false, ms: 1, output: "Failed" }] };
      second.checkReturns = 2;
      engine["checks"].blocked(task);
      const item = engine.s.inbox.find((item) => item.taskId === task.id && item.kind === "delivery")!;
      engine.rerunChecks(item.id);
      expect(first.checks).toEqual(expect.objectContaining({ current: true, sha: "delivered", tree: "first-tree" }));
      expect(second.checks.sha).toBeUndefined(); expect(second.checks.tree).toBeUndefined();
      expect(second.checkReturns).toBe(2); expect(second.approvedFor).toBeUndefined();
      expect(task.stageIndex).toBe(2); expect(task.state).toBe("waiting");
      expect(task.journey!.at(-1)!.outcome).toBe("Run checks again");
    } finally { await engine.shutdown(); }
  });

  it("returns a shared check repair from the delivery check or shipping through review, withdrawing approval", async () => {
    const { engine, task } = await fixture("check-routes");
    try {
      task.plan = plan();
      const second = executionFor(task, "second");
      task.findings = [{ id: "check", text: "Check failed: Tests (bun test)", productIds: ["second"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" }];
      const attempt = (from: number) => {
        for (const work of task.repositories!) {
          work.approvedSha = "approved"; work.approvedPatch = "patch"; work.approvedFor = { by: "coordinator", mode: "local", destination: "main" };
          delete work.checkReturns;
        }
        delete task.repair;
        task.stageIndex = from;
        expect(engine["checks"].backToBuilder(second, "in this test")).toBe(true);
        expect(task.stageIndex).toBe(0);
        expect(second.work.checkReturns).toBe(1);
        return [task.repair!.returnStage, task.repositories!.map((work) => work.approvedPatch ?? "withdrawn").join()];
      };
      // From the delivery check or shipping: through review, as one product walks forward, and the delivery check
      // asks again. Earlier gates return to themselves.
      expect([3, 4, 2, 1].map(attempt)).toEqual([[2, "withdrawn,withdrawn"], [2, "withdrawn,withdrawn"], [2, "patch,patch"], [1, "patch,patch"]]);
      expect(task.repair).toEqual({ products: ["second"], index: 0, returnStage: 1, kind: "checks" });
      // Once a product has published, the rest returns to shipping as before, keeping the approval it is compared with.
      task.repositories![0]!.landed = { branch: "main", sha: "a".repeat(40) };
      expect(attempt(4)).toEqual([4, "patch,patch"]);
    } finally { await engine.shutdown(); }
  });

  it("lists every product's failing checks, turns and answers at a shared check problem, and returns a change request there", async () => {
    const { engine, task, id } = await fixture("check-problem");
    try {
      engine.setPoolPaused(false);
      task.plan = plan();
      task.stageIndex = 1;
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      await checks.runProductChecks(first, [failing], signal);
      await checks.runProductChecks(second, [command("Tests", "console.log('(fail) greeting > says hello'); console.error('error: expected Hello'); process.exit(1)")], signal);
      first.work.checkReturns = 2;
      second.work.checkReturns = 1;
      // A run that did not finish (the Mac slept, say) is a failure of the same episode, and says so.
      setChecks(engine, "first", [failing]);
      first.work.checks!.results = [{ ...first.work.checks!.results[0]!, timedOut: true }];
      expect(await checks.failing(first, signal)).toBe(true);
      expect(first.work.checkReturns).toBe(2);
      const answered = task.findings.find((finding) => finding.productIds?.includes("second"))!;
      answered.answer = { fixed: false, text: "The suite timed out while the Mac slept.", at: Date.now() };
      answered.answers = { second: answered.answer };
      expect(checks.blocked(task)).toBe("stop");
      const item = engine.s.inbox.find((entry) => entry.taskId === id && entry.kind === "delivery")!;
      expect(item.title).toBe(`Your call on “${task.title}”: checks still fail (First: Welcome page, Second: Tests)`);
      expect(item.body).toContain("First: still failing after 2 automatic Builder turns.\n• Welcome page did not finish: The welcome page is missing");
      expect(item.body).toContain("Second: still failing after 1 automatic Builder turn.\n• Tests failed: (fail) greeting > says hello\nerror: expected Hello\n  The Builder's last answer: “The suite timed out while the Mac slept.”");
      expect(item.body).toContain("Stopped before acceptance testing.");
      expect(item.body).toContain("Approving does not ship while checks fail or remain unverified.");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      expect(task.stageIndex).toBe(1);
      expect(task.timeline.map((line) => line.text)).toContain("Checks still fail after their automatic Builder turns (First: Welcome page, Second: Tests), so Petrina waits for you before acceptance testing");
      // Asking for changes at acceptance testing repairs both products, then returns there and on through review.
      engine.requestChanges(item.id, "Fix both checks");
      expect(task.repair).toEqual({ products: ["first", "second"], index: 0, returnStage: 1, kind: "review" });
      expect(task.stageIndex).toBe(0);
      expect(first.work.checkReturns).toBe(2);
      expect(second.work.checkReturns).toBe(1);
    } finally { await engine.shutdown(); }
  });

  it("opens the check problem instead of repairing a passing product for a deleted test, and bounds a real failure there", async () => {
    const { engine, task } = await fixture("check-loop");
    try {
      engine.setPoolPaused(false);
      task.plan = plan();
      task.stageIndex = 2;
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      setChecks(engine, "first", [passing]);
      setChecks(engine, "second", [failing]);
      expect(await checks.failing(first, signal)).toBe(false);
      expect(await checks.failing(second, signal)).toBe(true);
      second.work.checkReturns = 2;
      // Petrina's deleted-test warning on the passing product is a blocking finding, but not a failing check.
      task.findings.push({ id: "deleted", text: "A test file was deleted: greeting.test.ts", productIds: ["first"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      const gate = async () => {
        // Each unchanged return rereads both saved results before the review gate decides.
        expect(await checks.failing(first, signal)).toBe(false);
        expect(await checks.failing(second, signal)).toBe(true);
        const returned = checks.backToBuilder(second, "before review");
        const products = task.repair?.products;
        delete task.repair;
        task.stageIndex = 2;
        return returned ? products : "blocked";
      };
      expect(await gate()).toBe("blocked");
      expect(task.findings.find((finding) => finding.id === "deleted")!.status).toBe("open");
      // Control: a real failure on the first product gets its own two returns, and then the blocker opens too.
      setChecks(engine, "first", [failing]);
      expect(await checks.failing(first, signal)).toBe(true);
      const turns = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await checks.failing(first, signal)).toBe(true);
        expect(await checks.failing(second, signal)).toBe(true);
        const returned = checks.backToBuilder(second, "before review");
        turns.push(returned ? [task.repair!.products, first.work.checkReturns] : "blocked");
        delete task.repair;
        task.stageIndex = 2;
      }
      expect(turns).toEqual([[["first"], 1], [["first"], 2], "blocked"]);
    } finally { await engine.shutdown(); }
  });

  it("ends an episode only when every check failure of the product is settled", async () => {
    const { engine, task } = await fixture("check-settled");
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      // A pre-commit hook that failed before, and does not run on this work: the product's own checks pass.
      const hook = join(first.work.worktree!, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
      task.findings.push({ id: "hook", text: "Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)", productIds: ["first"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      setChecks(engine, "first", [passing]);
      first.work.checkReturns = 1;
      expect(await checks.runProductChecks(first, [passing], signal)).toBe(0);
      expect(task.findings.find((finding) => finding.id === "hook")!.status).toBe("open");
      expect(first.work.checkReturns).toBe(1);
    } finally { await engine.shutdown(); }
  });

  it("keeps spent repairs when the required checks are replaced while a passing run is under way", async () => {
    const { engine, task } = await fixture("check-replaced");
    try {
      engine.setPoolPaused(false);
      const scope = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      const started = join(dirname(scope.work.worktree!), "check-started"), release = join(dirname(scope.work.worktree!), "check-release");
      const holding = command("Welcome page", `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(wait); console.log('The welcome page works'); } }, 20);`);
      setChecks(engine, "first", [holding]);
      scope.work.checkReturns = 2;
      const run = checks.failing(scope, signal);
      await waitFor(() => existsSync(started), "the original check to start");
      setChecks(engine, "first", [failing]);
      writeFileSync(release, "go");
      // The original pass cannot authorize continuation. The current failing requirement is
      // run within this operation, without granting any new Builder returns.
      expect(await run).toBe(true);
      expect(scope.work.checkReturns).toBe(2);
      const attempts = task.journey!.flatMap(step => step.checkAttempts ?? []);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.passed).toBe(false);
      expect(attempts[1]!.definition).not.toBe(attempts[0]!.definition);
      expect(await checks.failing(scope, signal)).toBe(true);
      expect(task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(2);
      expect(scope.work.checkReturns).toBe(2);
      // Control: a pass on the checks required now does end the episode.
      setChecks(engine, "first", [passing]);
      expect(await checks.failing(scope, signal)).toBe(false);
      expect(scope.work.checkReturns).toBeUndefined();
      expect(task.journey!.at(-1)!.checkAttempts![0]!.passed).toBe(true);
    } finally { await engine.shutdown(); }
  });
});
