import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, MAINTENANCE_ROLES, draftOf, FINDING_REVIEW_RULES, journeyProblems, mainLine, NOTES_HANDOFF_RULE, REPAIR_RULE, ROLE_STARTS, VERIFIER_RULES, type AnalyticsUsage, type RoleDraft, type State, type Task, type TaskUsage } from "@petrina/core";
import { Engine } from "./engine.js";
import { MAY_CHANGE } from "../src/prompts.js";
import { EARLIER_REPORTS_RULE } from "../src/context.js";
import { dispatch } from "../src/server.js";
import { Store } from "@petrina/storage/store";
import { findProgram } from "@petrina/agent-runtime/tools";
import { readGitHub } from "./fake-gh.js";
import { EngineProcess, Fakes, git, makeProduct, removeDir, SLOW, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;
const COPYWRITER: RoleDraft = { ...start("copywriter"), canEdit: true };
const FACT_CHECKER: RoleDraft = { ...start("blank"), name: "Fact checker", icon: "search", tone: "teal", purpose: "Checks every claim the change makes to users.", instructions: "Check every claim against the product.", handsBack: "Claims that do not hold." };

/** Answer questions and permissions and approve every check, like a coordinator would, until `done`. */
async function coordinate(engine: EngineProcess, taskId: string, done: (task: Task) => boolean, what: string): Promise<State> {
  const handled = new Set<string>();
  return waitFor(async () => {
    const state = await engine.state();
    const task = state.tasks.find((entry) => entry.id === taskId)!;
    if (task.state === "failed") throw new Error(`The task is stuck: ${task.error}`);
    if (done(task)) return state;
    for (const item of state.inbox.filter((entry) => entry.taskId === taskId && !handled.has(entry.id))) {
      handled.add(item.id);
      if (item.kind === "question") await engine.act("answer", item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") await engine.act("allow", item.id, "once");
      else await engine.act("approve", item.id);
    }
    return undefined;
  }, what, 60_000);
}

describe("roles the coordinator edits and adds", () => {
  for (const only of ["claude-code", "codex", "grok"] as const) {
    it(`plans added roles and high-risk reviews on ${only} when it is the only ready tool`, async () => {
      const root = tempDir("petrina-role-tools-");
      roots.push(root);
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ planner: "roles", risk: "high" });
      const engine = new Engine(join(root, "data"), {
        agentCommand: (profile) => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, ...(profile.toolId === only ? [] : ["--logged-out"])],
        which: (name) => name === "gh" ? null : findProgram(name),
        toolCheckTimeoutMs: 30_000 * SLOW,
      });
      try {
        await engine.checkTools();
        expect(engine.usableTools()).toEqual([only]);
        const security = engine.addRole(start("security"));
        const copywriter = engine.addRole(COPYWRITER);
        const facts = engine.addRole(FACT_CHECKER);
        const planner = engine.getState().roles.find((role) => role.id === "planner")!;
        engine.saveRole(planner.id, { ...draftOf(planner), instructions: "Keep this plan small." });
        const productId = await engine.addProduct(await makeProduct(root));
        const taskId = engine.addTask({ productId, title: "Plan the welcome message", approvePlan: true });
        const task = await waitFor(() => {
          const task = engine.getState().tasks.find((entry) => entry.id === taskId)!;
          if (task.state === "failed") throw new Error(task.error);
          return task.plan && task;
        }, "the plan with added roles");
        const state = engine.getState();
        const plan = task.plan!;
        const profiles = [plan.plannerProfileId, ...plan.stages.flatMap((stage) => [...stage.profileIds, ...(stage.reviewerProfileIds ?? [])])];
        expect([...new Set(profiles.map((id) => state.profiles.find((profile) => profile.id === id)?.toolId))]).toEqual([only]);
        expect(plan.stages.some((stage) => stage.roleIds?.includes(security))).toBe(true);
        expect(plan.stages.some((stage) => stage.roleId === facts)).toBe(true);
        expect(plan.stages.findIndex((stage) => stage.roleId === copywriter)).toBeLessThan(plan.stages.findIndex((stage) => stage.kind === "review-chain"));
        expect(plan.stages.some((stage) => stage.roleId === "security-reviewer")).toBe(true);
        const prompt = fakes.openings("planner")[0]!;
        expect(prompt).toContain("Keep this plan small.");
        expect(prompt).toContain(`Only ${state.tools.find((tool) => tool.id === only)!.name} is set up on this machine`);
        expect(prompt).toContain("reviewers included, even where a rule above asks for different tools");
        expect(prompt).toContain("Security specialist");
      } finally {
        await engine.shutdown();
      }
    });
  }

  for (const interruption of ["restart", "usage replacement"] as const) {
    it(`keeps each parallel reviewer's starting wording through a ${interruption}, then uses edits in the next round`, async () => {
      const root = tempDir("petrina-parallel-roles-");
      roots.push(root);
      const home = join(root, "home");
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ planner: "mixed-review", builder: "plain", controlled: true, ...(interruption === "usage replacement" ? { limited: [{ model: "opus", role: "code reviewer", type: "seven_day_opus", afterRelease: true }] } : {}) });
      let engine = await EngineProcess.harness(home, fakes.dir);
      try {
        const security = await engine.act("addRole", start("security")) as string;
        const before = await engine.state();
        const reviewers = before.roles.filter((role) => role.id === "code-reviewer" || role.id === security);
        const productId = await engine.act("addProduct", await makeProduct(root)) as string;
        await engine.act("setProductDelivery", productId, "local", false);
        const taskId = await engine.act("addTask", { productId, title: "Review the greeting", description: "A friendly greeting." }) as string;
        const released = new Set<string>();
        const isReviewer = (role: string) => role === "code reviewer" || role === "security specialist";
        const advance = (done: (state: State) => boolean, all = false) => waitFor(async () => {
          const state = await engine.state();
          const task = state.tasks.find((entry) => entry.id === taskId)!;
          if (task.state === "failed") throw new Error(task.error);
          for (const entry of fakes.received()) if ((all || !isReviewer(entry.role)) && !released.has(entry.session)) {
            writeFileSync(join(fakes.dir, `release-${entry.session}`), "");
            released.add(entry.session);
          }
          for (const item of state.inbox.filter((entry) => entry.taskId === taskId)) {
            if (item.kind === "question") await engine.act("answer", item.id, item.options?.[0] ?? "Yes");
            else if (item.kind === "permission") await engine.act("allow", item.id, "once");
            else await engine.act("approve", item.id);
          }
          return done(state) && state;
        }, "the parallel reviewers", 60_000);
        const active = await advance((state) => fakes.openings("code reviewer").length === 1 && fakes.openings("security specialist").length === 1 && state.tasks.find((entry) => entry.id === taskId)!.helpers?.length === 1);
        expect(active.tasks.find((entry) => entry.id === taskId)!.statusLine).toBe("2 reviewers looking at the change at once");
        for (const role of reviewers) await engine.act("saveRole", role.id, { ...draftOf(role), instructions: `${role.instructions}\nUse this new wording in the next review.` });
        if (interruption === "restart") {
          await engine.quit();
          engine = await EngineProcess.harness(home, fakes.dir);
          await advance(() => fakes.openings("code reviewer").length === 2 && fakes.openings("security specialist").length === 2);
        } else {
          const first = fakes.received("code reviewer")[0]!;
          writeFileSync(join(fakes.dir, `release-${first.session}`), "");
          released.add(first.session);
          await advance(() => fakes.openings("code reviewer").length === 2);
        }
        // Opening the replacement is earlier than its first plan update. Until that arrives,
        // retaining the outgoing agent's to-do item is intentional.
        const ready = await advance((state) => {
          const work = state.tasks.find((entry) => entry.id === taskId)!.hunt?.work;
          return [["reviewer:0", "code-reviewer"], ["reviewer:1", security]].every(([key, roleId]) =>
            work?.[key!]?.todo === `${reviewers.find((role) => role.id === roleId)!.name.toLowerCase()} is working`);
        });
        const during = ready.tasks.find((entry) => entry.id === taskId)!;
        expect(during.hunt?.profiles?.["0"]).toBeDefined();
        expect(during.hunt?.profiles?.["1"]).toBeDefined();
        if (interruption === "usage replacement") expect(during.hunt?.profiles?.["0"]).not.toBe("opus-high");
        expect(during.hunt?.roles?.["reviewer:0"]?.instructions).toBe(reviewers.find((role) => role.id === "code-reviewer")!.instructions);
        expect(during.hunt?.roles?.["reviewer:1"]?.instructions).toBe(reviewers.find((role) => role.id === security)!.instructions);
        // The summary and clock belong to the individual role, including one the coordinator added.
        for (const [key, roleId] of [["reviewer:0", "code-reviewer"], ["reviewer:1", security]] as const) {
          expect(during.hunt?.work?.[key]?.clock?.roleId).toBe(roleId);
          expect(during.hunt?.work?.[key]?.todo).toBe(`${reviewers.find((role) => role.id === roleId)!.name.toLowerCase()} is working`);
        }
        expect(mainLine(during)).toBe("code reviewer is working");
        expect(during.statusLine).toBe(interruption === "usage replacement" ? "Continuing work" : "2 reviewers looking at the change at once");
        if (interruption === "usage replacement") {
          expect(during.toolActivity?.lastActivity).toBe("Editing notes.txt");
          expect(during.toolActivity?.runningTool).toBeUndefined();
        }
        for (const role of reviewers) for (const opening of fakes.openings(role.name.toLowerCase())) {
          expect(opening).toContain(role.instructions);
          expect(opening).not.toContain("Use this new wording in the next review.");
        }
        const finished = await advance((state) => state.tasks.find((entry) => entry.id === taskId)!.state === "done", true);
        // The first round blocked on the added reviewer's finding. Its next round is a new step.
        for (const role of reviewers) expect(fakes.openings(role.name.toLowerCase()).at(-1)).toContain("Use this new wording in the next review.");
        expect(finished.tasks.find((entry) => entry.id === taskId)!.hunt).toBeUndefined();
        const history = finished.tasks.find((entry) => entry.id === taskId)!.steps ?? [];
        for (const role of reviewers) expect(history.some((step) => step.roleId === role.id && step.repeat)).toBe(true);
      } finally {
        await engine.quit();
      }
    }, 120_000);
  }

  for (const call of [false, true]) {
    it(`saves the Architect's permitted edits before read-only steps ${call ? "after the coordinator's call and later revisions" : "in normal design rounds"}`, async () => {
      const root = tempDir("petrina-architect-edits-");
      roots.push(root);
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ architect: "writes", builder: "plain" });
      const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
      try {
        const architect = engine.getState().roles.find((role) => role.id === "architect")!;
        engine.saveRole(architect.id, { ...draftOf(architect), canEdit: true });
        const productId = await engine.addProduct(await makeProduct(root));
        const taskId = engine.addTask({ productId, title: "Design a greeting", description: call ? "[disagree] [screens]" : "A greeting." });
        const checkpoint = (kind: "disagreement" | "design") => waitFor(() => {
          const state = engine.getState();
          const task = state.tasks.find((entry) => entry.id === taskId)!;
          if (task.state === "failed") throw new Error(task.error);
          const item = state.inbox.find((entry) => entry.taskId === taskId && entry.kind === kind);
          if (item) return { item, task };
          for (const entry of state.inbox.filter((entry) => entry.taskId === taskId)) {
            if (entry.kind === "question") engine.answer(entry.id, entry.options?.[0] ?? "Yes");
            else if (entry.kind === "permission") engine.allow(entry.id, "once");
            else if (entry.kind === "plan") engine.approve(entry.id);
          }
          return undefined;
        }, kind);
        const first = await checkpoint(call ? "disagreement" : "design");
        // A read-only design reviewer has run after the Architect. Its clean-up must keep the Architect's work.
        expect(await git(first.task.worktree!, "show", "HEAD:architecture.txt")).toBe("Before the design review");
        expect(await git(first.task.worktree!, "log", "-1", "--format=%s")).toBe("Design a greeting: Architect");
        if (call) {
          engine.requestChanges(first.item.id, "Show the greeting to everyone.");
          const followed = await checkpoint("design");
          // The read-only Screens step runs after following the call, before the check.
          expect(await git(followed.task.worktree!, "show", "HEAD:architecture.txt")).toBe("After the coordinator's call");
          engine.requestChanges(followed.item.id, "Make the greeting shorter.");
          const revised = await checkpoint("design");
          expect(await git(revised.task.worktree!, "show", "HEAD:architecture.txt")).toBe("After the design check");
        }
        expect(await git(first.task.worktree!, "status", "--porcelain")).toBe("");
        engine.cancel(taskId);
      } finally {
        await engine.shutdown();
      }
    });
  }

  it("keeps added reviewers on their planned tool near its usage limit, just like built-in reviewers", async () => {
    const root = tempDir("petrina-reviewer-usage-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { toolPath: () => process.execPath });
    try {
      const reviewer = engine.addRole(start("security"));
      // A provider warning at low measured usage moves no role off its planned profile.
      engine.recordUsage({ toolId: "claude-code", kind: "five_hour", status: "allowed_warning", utilization: 0.26 });
      for (const roleId of [reviewer, "builder", "code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
        expect(engine.choose("opus-high", undefined, roleId)).toMatchObject({ kind: "planned", profile: { id: "opus-high" } });
      }
      engine.recordUsage({ toolId: "claude-code", kind: "five_hour", status: "allowed_warning", utilization: 0.95 });
      // An author planned on Claude Code moves to Codex; every reviewer keeps Claude Code instead.
      expect(engine.choose("opus-high", undefined, "builder")).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
      for (const roleId of [reviewer, "code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
        expect(engine.choose("opus-high", undefined, roleId)).toMatchObject({ kind: "planned", profile: { id: "opus-high" } });
      }
      // A real limit still permits a stand-in; nearing a limit does not.
      engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 60_000, reason: "Usage used up" }];
      expect(engine.choose("opus-high", undefined, reviewer)).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
    } finally {
      await engine.shutdown();
    }
  });

  it("keeps added and built-in reviewers independent of each other's saved verdicts and the latest port builder", async () => {
    const root = tempDir("petrina-added-independence-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { toolPath: () => process.execPath, usageCommands: { codex: null } });
    try {
      engine.setPoolPaused(true);
      const added = engine.addRole(start("security"));
      const productId = await engine.addProduct(await makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Review the greeting" });
      const task = engine.s.tasks.find((entry) => entry.id === taskId)!;
      task.plan = { plannerProfileId: "opus-high", rationale: "Two independent reviews.", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high", "sol-high"], roleIds: ["code-reviewer", added] }] };
      task.stageIndex = 0;
      task.rounds.review = 1;
      // With Claude unavailable, Grok is the only tool independent of the reviewer who finished on Codex.
      engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 60_000, reason: "Usage used up" }];
      for (const position of [0, 1]) {
        const roleId = task.plan.stages[0]!.roleIds![position]!;
        const peer = 1 - position;
        task.hunt = { stageId: "review", round: 1, reported: { [peer]: true }, profiles: { [peer]: "sol-high" } };
        expect(engine.choose("sol-high", task, roleId, undefined, String(position))).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
        // Older saved rounds have the verdict, but no record of which profile used each position.
        delete task.hunt.profiles;
        engine.tracking.verdict(task, task.plan.stages[0]!.roleIds![peer]!, "sol-high", 1, "pass", 0, 0);
        expect(engine.choose("sol-high", task, roleId, undefined, String(position))).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
      }
      executionFor(task).work.builderSession = { stageId: "build", profileId: "sol-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "latest-port" };
      executionFor(task).work.portReview = { from: "a", onto: "b", head: "c", files: ["greeting.txt"] };
      expect(engine.choose("sol-high", task, added, undefined, "1")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
    } finally {
      await engine.shutdown();
    }
  });

  it("are planned, briefed, reviewed, committed and kept in check like built-in ones, and survive a restart", async () => {
    const root = tempDir("petrina-roles-");
    roots.push(root);
    const product = await makeProduct(root);
    const home = join(root, "home");
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "roles", builder: "plain" });
    await git(product, "remote", "set-url", "origin", "https://github.com/acme/demo.git");
    let engine = await EngineProcess.harness(home, fakes.dir, join(root, "origin.git"));

    // The coordinator changes a built-in role's wording and adds three of their own.
    const researcher = (await engine.state()).roles.find((role) => role.id === "researcher")!;
    await engine.act("saveRole", "researcher", { ...researcher, purpose: "Finds out what people expect, with sources." });
    const builder = (await engine.state()).roles.find((role) => role.id === "builder")!;
    await engine.act("saveRole", "builder", { ...draftOf(builder), instructions: "Keep the greeting simple and match this product's style." });
    const verifier = (await engine.state()).roles.find((role) => role.id === "verifier")!;
    const verifierWording = "Check each reported problem against the approved request.";
    await engine.act("saveRole", "verifier", { ...draftOf(verifier), instructions: verifierWording });
    const security = (await engine.act("addRole", start("security"))) as string;
    const copywriter = (await engine.act("addRole", COPYWRITER)) as string;
    const factChecker = (await engine.act("addRole", FACT_CHECKER)) as string;
    expect([security, copywriter, factChecker]).toEqual(["added-security-specialist", "added-copywriter", "added-fact-checker"]);

    const productId = (await engine.act("addProduct", product)) as string;
    await engine.act("setProductDelivery", productId, "pull-request", false);
    const taskId = (await engine.act("addTask", { productId, title: "Add a greeting", description: "A friendly greeting. [roles]", approvePlan: true })) as string;
    let state = await engine.until((current) => current.inbox.some((item) => item.taskId === taskId && item.kind === "plan"), "the plan");
    const planned = state.tasks.find((task) => task.id === taskId)!.plan!;

    // The planner saw every role it may use, the added ones included, and none it may not.
    const plannerPrompt = fakes.openings("planner")[0]!;
    expect(plannerPrompt).toContain("- researcher (Researcher): Finds out what people expect, with sources. | read-only | hands back: Research notes with sources. | fits: a \"do\" stage");
    expect(plannerPrompt).toContain(`- ${security} (Security specialist): `);
    expect(plannerPrompt).toContain("fits: a reviewer in a \"review-chain\" stage");
    expect(plannerPrompt).not.toMatch(/^- (planner|shipper) /m);
    // The Copywriter changes the product, so Petrina moved it before the final review; the read-only Fact checker stays after it.
    expect(planned.stages.map((stage) => stage.title)).toEqual(["Research", "Design", "Your design check", "Build", "Copy", "Review", "Fact check", "Open a pull request"]);
    expect(planned.stages.find((stage) => stage.kind === "review-chain")!.roleIds).toEqual(["code-reviewer", security]);
    expect(planned.rationale).toContain("Petrina moved “Copy” before the final review");
    expect(planned.stages.at(-1)!.roleId).toBe("release-manager");

    // After planning, the Fact checker is switched to changing the product, then removed: the task still runs it, read-only.
    await engine.act("saveRole", factChecker, { ...FACT_CHECKER, canEdit: true });
    await engine.act("removeRole", factChecker);
    // The Copywriter is held halfway through its first step, while the coordinator makes it read-only.
    writeFileSync(join(fakes.dir, "hold-copywriter"), "");
    await engine.act("approve", state.inbox.find((item) => item.taskId === taskId && item.kind === "plan")!.id);
    await coordinate(engine, taskId, () => fakes.marked("working-copywriter"), "the copywriter to start");
    await engine.act("saveRole", copywriter, { ...COPYWRITER, canEdit: false });
    rmSync(join(fakes.dir, "hold-copywriter"));
    state = await coordinate(engine, taskId, (task) => task.state === "pr-open", "the pull request");
    const task = state.tasks.find((entry) => entry.id === taskId)!;
    expect(journeyProblems(task)).toEqual([]);
    const reviewStage = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
    const reviewsInJourney = task.journey!.filter((step) => step.kind === "agent" && step.stageId === reviewStage.id && step.roleId === reviewStage.roleId);
    expect(reviewsInJourney).toHaveLength(2);
    for (const step of reviewsInJourney) expect(new Set(step.team)).toEqual(new Set(reviewStage.profileIds));
    expect(readGitHub(join(fakes.dir, "github.json")).prs[0]!.body).toContain("- Security specialist on ");
    const usage = await engine.act("usage", { view: "task", taskId }) as TaskUsage;
    expect(usage.stages.flatMap((stage) => stage.agents).some((agent) => agent.roleId === security)).toBe(true);
    const analytics = await engine.act("usage", { view: "analytics", period: "7d" }) as AnalyticsUsage;
    // Added reviewers count their stages, working time and verdicts next to the code reviewers.
    expect(analytics.squad.details.reviewers).toHaveLength(2);
    expect(analytics.squad.details.reviewers.every((reviewer) => reviewer.stages > 0 && reviewer.rounds > 0 && reviewer.time.value !== undefined)).toBe(true);
    const said = (text: string) => task.timeline.some((entry) => entry.text.startsWith(text));

    // The researcher's notes reached the architect, beside the reminder to verify them.
    expect(fakes.openings("architect")[0]).toContain(`## What earlier agents on this task handed back\n${EARLIER_REPORTS_RULE}\n\nResearcher, in “Research”: Notes from the researcher.\n- A note from the researcher`);
    // Built-in and added notes roles alike were told that only their saved report reaches later agents.
    for (const role of ["researcher", "copywriter", "fact checker"]) {
      expect(fakes.openings(role).length).toBeGreaterThan(0);
      for (const opening of fakes.openings(role)) expect(opening.split(NOTES_HANDOFF_RULE)).toHaveLength(2);
    }

    // The Copywriter finished its first step as it started, changing the product: Petrina committed its work with its name.
    const copy = fakes.openings("copywriter");
    expect(copy).toHaveLength(2);
    expect(copy[0]).toContain(MAY_CHANGE.canEdit);
    expect(said("Saved the changes from the Copywriter on the task's branch")).toBe(true);
    // Its next step used the new version: read-only, so what it committed was undone, and its saved work stayed.
    expect(copy[1]).toContain(MAY_CHANGE.readOnly);
    expect(said("Undid commits from Copywriter, which is read-only")).toBe(true);
    expect(await git(task.worktree!, "show", "HEAD:copywriter.txt")).toBe("Written while changing the product");
    // Petrina later folds step commits into the task’s single delivery commit.

    // The Security reviewer joined the review: its blocking finding, under its name, went back to the builder.
    const finding = task.findings.find((entry) => entry.roleId === security)!;
    expect(finding.severity).toBe("blocking");
    expect(finding.status).toBe("fixed");
    expect(said("Sent back to the builder: 1 important")).toBe(true);
    const repair = fakes.openings("builder")[1]!;
    expect(repair).toContain(finding.text);
    expect(repair).toContain("Keep the greeting simple and match this product's style.");
    expect(repair.split(REPAIR_RULE)).toHaveLength(2);
    expect(repair).toContain("fast focused static or type check");
    expect(repair).toContain("Petrina runs them on the finished work before review");
    const reviews = fakes.openings("security specialist");
    expect(reviews[0]).toContain("Review the change on branch");
    expect(reviews[0]).toContain("Look for security problems the change brings in");
    expect(reviews[0]).toContain("## What the builder reports");
    for (const prompt of reviews) for (const rule of FINDING_REVIEW_RULES) expect(prompt.split(rule)).toHaveLength(2);
    const votes = fakes.openings("verifier");
    expect(votes.length).toBeGreaterThan(0);
    for (const prompt of votes) {
      expect(prompt).toContain(verifierWording);
      for (const rule of VERIFIER_RULES) expect(prompt.split(rule)).toHaveLength(2);
    }
    expect(reviews[1]).toContain("## Findings so far (confirm or dispute by id)");
    // It follows the rule that a dispute always gives its reason: it is told so, and Petrina refused its dispute without one.
    expect(reviews[0]).toContain("Dispute findings you think are wrong by id, always with the reason and your evidence");
    expect(reviews[0]).toContain('"disputes": [{"id": "<id of an earlier finding you think is wrong>", "reason": "Why it is wrong, with evidence"}]');
    expect(fakes.received("security specialist").some((entry) => entry.text.startsWith("Your result block could not be used: disputes.0"))).toBe(true);

    // The removed Fact checker still ran, after the final review, read-only: Petrina said why and undid its commit.
    expect(fakes.openings("fact checker")[0]).toContain(MAY_CHANGE.afterReview);
    expect(said("Fact checker works read-only on this task: its step comes after the final review")).toBe(true);
    expect(said("Undid commits from Fact checker, which is read-only")).toBe(true);
    expect(existsSync(join(task.worktree!, "fact-checker.txt"))).toBe(false);
    expect(state.roles.find((role) => role.id === factChecker)).toMatchObject({ name: "Fact checker", removed: true });

    // Agents use the same background login handling as main, including added roles.
    for (const open of fakes.opens()) expect(open.background).toBe(true);

    // Everything the coordinator changed is still there after a restart.
    await engine.quit();
    engine = await EngineProcess.harness(home, fakes.dir, join(root, "origin.git"));
    const roles = (await engine.state()).roles;
    expect(roles.find(role => role.id === "verifier")?.instructions).toBe(verifierWording);
    expect(roles.find((role) => role.id === "researcher")).toMatchObject({ purpose: "Finds out what people expect, with sources.", edited: true });
    expect(roles.find((role) => role.id === copywriter)).toMatchObject({ name: "Copywriter", canEdit: false, added: true });
    expect(roles.find((role) => role.id === security)).toMatchObject({ result: "findings", canEdit: false, column: "reviewing" });
    expect(roles.find((role) => role.id === factChecker)?.removed).toBe(true);
    await engine.quit();
  }, 120_000);

  const restarts: ["resume" | undefined, "quit" | "kill"][] = [
    ["resume", "kill"],
    [undefined, "quit"],
  ];
  for (const [reopen, stop] of restarts) {
    it(`keep a working agent's version of its role through a restart ${reopen ? "that reopens its conversation" : "that starts the step again"}, after the role is reworded, renamed and made read-only`, async () => {
      const root = tempDir("petrina-roles-");
      roots.push(root);
      const product = await makeProduct(root);
      const home = join(root, "home");
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ planner: "copy", builder: "plain", notes: "work", ...(reopen ? { reopen } : {}) });
      let engine = await EngineProcess.harness(home, fakes.dir);
      const copywriter = (await engine.act("addRole", COPYWRITER)) as string;
      const productId = (await engine.act("addProduct", product)) as string;
      await engine.act("setProductDelivery", productId, "local", false);
      const taskId = (await engine.act("addTask", { productId, title: "Add a greeting", description: "A friendly greeting." })) as string;

      // The Copywriter drafts a file, then the coordinator rewords, renames and makes it read-only while it works, and Petrina restarts.
      await coordinate(engine, taskId, () => fakes.marked("working-copywriter"), "the copywriter to start");
      const edited = { ...COPYWRITER, name: "Wordsmith", purpose: "Shouts every word.", instructions: "Write every word in capitals.", handsBack: "Loud words.", canEdit: false };
      await engine.act("saveRole", copywriter, edited);
      if (stop === "kill") await engine.kill();
      else await engine.quit();
      engine = await EngineProcess.harness(home, fakes.dir);
      const state = await coordinate(engine, taskId, (task) => task.state === "done", "the task to finish");
      const task = state.tasks.find((entry) => entry.id === taskId)!;
      const said = (text: string) => task.timeline.some((entry) => entry.text.startsWith(text));

      // It finished its step as it started it, changing the product: its draft was saved, never undone.
      const sessions = new Set(fakes.received("copywriter").map((entry) => entry.session));
      expect(sessions.size).toBe(reopen ? 1 : 2);
      // Its wording and name too, even in a fresh conversation after the restart: the new version never reached it.
      for (const opening of fakes.openings("copywriter")) {
        expect(opening).toContain(MAY_CHANGE.canEdit);
        expect(opening).toContain(`# Your job\n${COPYWRITER.instructions}`);
        expect(opening).toContain(`Your role: ${COPYWRITER.purpose}`);
        expect(opening).toContain(`What you hand back: ${COPYWRITER.handsBack}`);
      }
      for (const entry of fakes.received("copywriter")) for (const word of [edited.instructions, edited.purpose, edited.handsBack]) expect(entry.text).not.toContain(word);
      expect(fakes.received("wordsmith")).toEqual([]);
      expect(said("Saved the changes from the Copywriter on the task's branch")).toBe(true);
      expect(said("Undid")).toBe(false);
      expect(await git(product, "show", "main:copywriter.txt")).toBe("A first draft");
      // The next agent gets the new version.
      expect(state.roles.find((role) => role.id === copywriter)).toMatchObject({ name: "Wordsmith", instructions: edited.instructions, canEdit: false });
      await engine.quit();
    }, 120_000);
  }
});

describe("the engine's own rules for roles", () => {
  it("refuses invalid role changes sent straight to it, past the form, in plain words", async () => {
    const root = tempDir("petrina-role-rules-");
    roots.push(root);
    const engine = new Engine(join(root, "home"));
    const act = (name: string, ...args: unknown[]) => dispatch(engine, { name, args });
    const draft = (id: string, change: Partial<RoleDraft> = {}) => ({ ...draftOf(engine.getState().roles.find((role) => role.id === id)!), ...change });
    try {
      const refused: [string, unknown[], string][] = [
        ["saveRole", ["nobody", draft("builder")], "That role is not in the Library."],
        ["saveRole", ["release-manager", draft("release-manager", { purpose: "Ships faster." })], "The Release Manager writes release notes"],
        ["resetRole", ["release-manager"], "The Release Manager writes release notes"],
        ["saveRole", ["planner", draft("planner", { canEdit: true })], "The Planner is always read-only"],
        ["saveRole", ["builder", draft("builder", { canEdit: false })], "The Builder always makes changes"],
        ["saveRole", ["code-reviewer", draft("code-reviewer", { canEdit: true })], "Reviewers never change the work they judge"],
        ["saveRole", ["tester", draft("tester", { result: "notes" })], "To hand back something else, add a new role."],
        ["saveRole", ["tester", draft("tester", { name: "QA" })], "Built-in roles keep their name, icon and colour"],
        ["saveRole", ["tester", draft("tester", { instructions: "x".repeat(4001) })], "Keep this to 4,000 characters"],
        ["saveRole", ["researcher", draft("researcher", { category: "maintenance" })], "A role keeps its Workflow or Maintenance category"],
        ["saveRole", ["maintenance-bug-finder", draft("maintenance-bug-finder", { category: "workflow" })], "A role keeps its Workflow or Maintenance category"],
        ["addRole", [{ ...ROLE_STARTS[0]!.draft, name: "builder", purpose: "Builds more." }], "There is already a role called “Builder”"],
        ["addRole", [{ ...ROLE_STARTS[1]!.draft, canEdit: true }], "Reviewers never change the work they judge"],
        ["removeRole", ["architect"], "Built-in roles can't be removed"],
      ];
      for (const [name, args, message] of refused) {
        const before = JSON.stringify({ roles: engine.getState().roles, changes: engine.getState().roleChanges });
        await expectRejection(act(name, ...args), message);
        expect(JSON.stringify({ roles: engine.getState().roles, changes: engine.getState().roleChanges })).toBe(before);
      }
      for (let n = 1; n <= 20; n += 1) await act("addRole", { ...ROLE_STARTS[0]!.draft, name: `Helper ${n}`, purpose: "Helps." });
      await expectRejection(act("addRole", { ...ROLE_STARTS[0]!.draft, name: "Helper 21", purpose: "Helps." }), "You can add at most 20 roles");
      const helper = engine.getState().roles.find((role) => role.name === "Helper 1")!;
      await expectRejection(act("saveRole", helper.id, { ...draftOf(helper), result: "findings" }), "add a new role");
      // Nothing refused changed anything.
      expect(engine.getState().roles.filter((role) => !role.added)).toEqual([...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].map((role) => ({ ...role })));
    } finally {
      await engine.shutdown();
    }
  });

  it("loads data saved before roles were editable with both built-in categories, without duplicating them on restart", async () => {
    const root = tempDir("petrina-role-upgrade-");
    roots.push(root);
    const home = join(root, "home");
    const store = new Store(join(home, "petrina.db"));
    const old = BUILT_IN_ROLES.map(({ instructions: _instructions, result: _result, ...role }) => role);
    store.save({ now: 1, seq: 3, products: [], roles: old, tools: [], profiles: [], tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: {} } } as unknown as State);
    store.close();
    let engine = new Engine(home);
    try {
      const defaults = [...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].map((role) => ({ ...role }));
      expect(engine.getState().roles).toEqual(defaults);
      expect(engine.getState().roleChanges).toEqual({ edits: {}, added: [] });
      await engine.shutdown();
      engine = new Engine(home);
      expect(engine.getState().roles).toEqual(defaults);
      expect(engine.getState().roleChanges).toEqual({ edits: {}, added: [] });
    } finally {
      await engine.shutdown();
    }
  });
});
