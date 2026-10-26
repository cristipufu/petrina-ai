import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "..");
import { acceptanceAgents } from "./acceptance-agents.js";
import { spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, type DeepMutable, type Product, type Task, type WorkflowEvent } from "@petrina/core";
import { git, makeProduct, tempDir, waitFor } from "../fixtures.js";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { commandInputText } from "../../src/checks.js";
import { Coordination } from "../../src/coordination.js";

/** The parts of a review's completion report these cases read. */
type ReviewReport = WorkflowEvent & { openImportant: string[]; stillOpen: string[]; reopened: unknown[]; heldForDecision?: string[]; reportCounts: { closing: { open: { important: number } } } };

import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { installPreparedProduct } from "./prepared-product.js";

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
  async function fixture(options: { gate: boolean; checklist?: readonly string[]; custom?: boolean }) {
    const root = tempDir("petrina-acceptance-repair-");
    const lifetime = directDrivers(root); fixtures.add(lifetime);
    const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
    return setupWithCleanup(() => lifetime.prepare(async () => {
      const responses = acceptanceAgents();
      const engineOptions = { agentCommand: () => [process.execPath, join(TEST_FIXTURE_ROOT, "unconfigured-service.ts"), "acceptance fixture"], startAgentSession: responses.start, terminals: () => [] };
      const engine = lifetime.open(join(root, "data"), engineOptions);
      engine.schedule = () => {};
      await engine.waitUntilReady();
      engine.setPoolPaused(false);
      const products: DeepMutable<Product>[] = [];
      for (let i = 0; i < 2; i++) {
        const dir = join(root, `product-${i}`); mkdirSync(dir);
        const repo = await makeProduct(dir, { origin: "none" });
        const id = installPreparedProduct(engine, { id: i === 0 ? "clone" : "clone-2", path: repo, name: `Product ${i + 1}`, repo: "local/clone",
          tone: i === 0 ? "blue" : "green", defaultBranch: "main", delivery: "local", approveDelivery: options.gate });
        engine.setProductChecks(id, [{ name: "Test", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) }]);
        products.push(engine.s.products.find(product => product.id === id)!);
      }
      const task = engine.task(engine.addTask({ productId: products[0]!.id, title: "Show the greeting", backlog: true }))!;
      const owners = [];
      for (const [i, product] of products.entries()) {
        const worktree = join(root, `work-${i}`), baseSha = await git(product.path!, "rev-parse", "HEAD"), branch = `greeting-${i}`;
        await git(product.path!, "worktree", "add", "-q", "-b", branch, worktree, baseSha);
        writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
        await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Add the greeting");
        owners.push({ productId: product.id, worktree, baseSha, base: baseSha, branch, delivery: "local" as const, completedStages: ["build"], preparation: "ready" as const,
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
      const f = {
        root, responses, engine, task, products, close, ids: products.map(product => product.id) as [string, string], review, security, tester: tester.roleId,
        mains: () => {
          const engine = f.engine;
          return lifetime.run(engine, () => completeAll(products.map(product => git(product.path!, "rev-parse", "main"))));
        },
        /** Runs the task until it waits, stops, or (with `stop`) is about to admit an agent while `stop` holds. */
        drive: (stop?: (task: Task) => boolean) => {
          const engine = f.engine, task = f.task;
          return lifetime.run(engine, async () => {
            const admit = spyOn(engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockImplementation(async () => !stop?.(task as Task));
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
        }),
      };
      return f;
    }), close);
  }
  return { fixture, close };
}
