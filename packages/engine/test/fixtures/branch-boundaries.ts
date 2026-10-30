import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import type { ProductCheck, Task, TaskSource } from "@petrina/core";
import { writeGitProgram } from "@petrina/test-support/git-program";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { coordinator } from "../support.js";
import { FAKE_AGENT, Fakes, createProductRepository, tempDir, waitFor } from "../fixtures.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { directDrivers } from "./direct-drivers.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import { updateAgents } from "./update-agents.js";

type BoundaryInput = { conversation: "resume" | "unsupported" }
  | { check: "tracked-write" | "unapproved-commit" }
  | { check: "commit-message"; builderTitle: string; hook: string };

/** Actual native phase owners with private committed inputs; earlier workflow stages are not claimed. */
async function branchBoundary(input: BoundaryInput) {
  const root = tempDir("petrina-branch-boundary-"), owners = directDrivers(root);
  const close = () => owners.close();
  return setupWithCleanup(() => owners.prepare(async () => {
    const { path: repo, initialSha: before } = await createProductRepository(root);
    const copy = join(root, "work"), branch = "prepared-task";
    await gitOps.ensureWorktree(repo, copy, branch, before);
    const fakes = "conversation" in input ? new Fakes(join(root, "native-peer")) : undefined;
    fakes?.scenario({ reviewer: "important", ...("conversation" in input && input.conversation === "resume" ? { reopen: "resume" } : {}) });
    const replies = "check" in input && input.check === "commit-message"
      ? updateAgents(join(root, "builder-replies"), { title: input.builderTitle }) : undefined;
    const readiness = scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" },
      grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" }, node: { status: "ready" } });
    const engine = owners.open(join(root, "data"), {
      ...(fakes ? { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], startAgentSession: fakeAgentSessions(fakes), toolPath: () => process.execPath }
        : replies ? { startAgentSession: replies.startAgentSession, agentCommand: () => { throw new Error("The title boundary requires its explicit scripted Builder"); } }
        : { agentCommand: () => { throw new Error("The restoration boundary starts no agents"); } }),
      toolProbe: readiness,
    });
    engine.schedule = () => engine.checkQueue.pump();
    await engine.waitUntilReady(); await engine.checkTools();
    engine.s.pool.paused = false; engine.s.pool.limit = 2;
    engine.s.products.push({ id: "product", name: "Product", path: repo, repo: "local/product", tone: "blue", defaultBranch: "main", checks: [], checksBy: "coordinator" });
    const id = engine.addTask({ productId: "product", title: "Add a greeting", delivery: "local", backlog: true });
    const task = engine.task(id)!, scope = executionFor(task);
    const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
    const gate = { id: "approval", title: "Approve delivery", kind: "gate" as const, gate: "delivery" as const, roleId: "coordinator", profileIds: [] };
    const ship = { id: "ship", title: "Deliver", kind: "do" as const, roleId: "release-manager", profileIds: ["sol-high"] };
    task.plan = { rationale: "Only the selected native boundary is exercised", plannerProfileId: "sol-high", stages: [build,
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 }, gate, ship] };
    Object.assign(task, { state: "running", startedAt: Date.now(), stageIndex: 0 });
    Object.assign(scope.work, { worktree: copy, branch, base: "main", baseSha: before, delivery: "local",
      source: { product: { id: "product", name: "Product", path: repo, repo: "local/product" }, start: { kind: "default", branch: "main" },
        destination: { kind: "branch", mode: "local", repo: "local/product", branch: "main" }, initialSha: before, confirmed: true } satisfies TaskSource });
    const snapshot = (): Task => engine.taskDetails(id)!;
    const signal = engine.stopRequested.signal;
    // The actual operation owns every native callback. Permission progress observes that operation.
    const buildTurn = async () => {
      const running = owners.run(engine, () => engine["work"].runDo(scope, build, signal));
      let settled = false;
      const observed = running.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => { coordinator([])(engine, engine.getState()); return settled; }, "the Builder's actual phase to settle", 90_000, { during: running });
      await observed;
      if (await running !== "continue") throw new Error("The Builder stopped before returning its actual result");
      return snapshot();
    };
    if ("check" in input && input.check !== "commit-message") {
      // A supplied already-built input: no Builder/reviewer execution is claimed for these two check contracts.
      writeFileSync(join(copy, "greeting.txt"), "Hello (with left-pad)\n");
      await gitOps.commitChanges(copy, "Add a greeting");
      scope.work.report = { summary: "Added a greeting.", title: "Add a greeting", changes: ["People see a greeting"] };
    }
    if ("check" in input) {
      const checks: ProductCheck[] = input.check === "tracked-write" ? [{ name: "Format", argv: ["git", "mv", "README.md", "README.txt"] }]
        : input.check === "unapproved-commit" ? [{ name: "Sneaky", argv: ["git", "commit", "-q", "--allow-empty", "-m", "Not reviewed"] }] : [];
      // These contracts consume declared argv; command-text parsing is a separate boundary.
      const product = engine.s.products.find(product => product.id === "product")!;
      product.checks = checks.map(check => ({ ...check, argv: [...check.argv] })); product.checksBy = "coordinator";
      if (input.check === "commit-message") {
        const path = join(repo, ".git", "hooks", "commit-msg");
        writeGitProgram(path, input.hook);
      }
    }
    engine.commitNow(task);
    return { root, repo, copy, before, engine, scope, task: snapshot, fakes, buildTurn, close,
      repair: () => owners.run(engine, async () => {
        if (!scope.work.builderSession || !scope.work.report || !task.journey?.some(step => step.roleId === "builder" && step.agentResults?.length))
          throw new Error("The repair input requires an actually completed first Builder");
        // The finding and second job are supplied input, not an invented review/electorate outcome.
        task.findings.push({ id: "prepared-review-finding", text: "The greeting needs a clearer welcome", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] });
        task.fixing = true; task.stageIndex = 0; task.sub = 0; task.state = "running";
        return buildTurn();
      }),
      verifyAndLand: () => owners.run(engine, async () => {
        if (!("check" in input)) throw new Error("Conversation boundaries do not publish");
        if (input.check === "commit-message") await buildTurn();
        task.stageIndex = 2; task.sub = 0; task.state = "running";
        const prepared = await engine["driver"]["deliveryCheckpoint"](scope, signal);
        const question = engine.s.inbox.find(item => item.taskId === id && item.kind === "delivery");
        if (prepared.kind !== "stop" || !question || !scope.work.checkedSha || !scope.work.checks?.environment)
          throw new Error(`The actual check gate did not verify the prepared input: ${task.statusLine}`);
        engine.approve(question.id);
        if (await engine["shipping"].deliver(task, ship, signal) !== "stop" || snapshot().state !== "done")
          throw new Error(`The actual local publication did not finish: ${task.statusLine}`);
        return snapshot();
      }),
    };
  }), close);
}

/** Keep native reopen/fallback and actual Work/Context/session recording, omitting unrelated stages. */
export function preparedBuilderConversation(reopen: "resume" | "unsupported") {
  return branchBoundary({ conversation: reopen });
}

/** Keep actual command mutation/restoration and approved native publication. */
export function preparedCheckedLanding(input: { check: "tracked-write" | "unapproved-commit" } | { check: "commit-message"; builderTitle: string; hook: string }) {
  return branchBoundary(input);
}
