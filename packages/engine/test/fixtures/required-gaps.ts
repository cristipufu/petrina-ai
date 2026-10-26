import { directDrivers, closeDirectDrivers, removeFixtureRoot } from "./direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { installPreparedProduct } from "./prepared-product.js";
import { acceptanceAgents } from "./acceptance-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import type { Scenario } from "../fake-agent.js";
import { spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { completeAll, type DeepMutable, type Product } from "@petrina/core";
import { Fakes, git, makeProduct, tempDir } from "../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "../../src/checks.js";

const TEST_FIXTURE_ROOT = resolve(import.meta.dir, "..");

/** Private native acceptance worlds; each caller owns its collection and returned operations. */
export function requiredGapFixtures(required: string) {
  const roots: string[] = [];
  const fixtures = new Set<ReturnType<typeof directDrivers>>();
  const close = async () => {
    await closeDirectDrivers(fixtures); fixtures.clear();
    roots.forEach(removeFixtureRoot);
  };

  /**
   * A task past its build, with delivery approval off for the task and its products: the plan has no delivery check.
   * The Tester, the reviewer and publishing run for real; the coding tools are the scripted stand-ins.
   */
  async function fixture(options: { shared?: boolean; checklist?: readonly string[]; role?: "built-in" | "custom" | "task-owned"; github?: boolean; native?: boolean } = {}) {
    const root = tempDir("petrina-acceptance-gap-"); roots.push(root);
    const lifetime = directDrivers(root); fixtures.add(lifetime);
    const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
    return setupWithCleanup(() => lifetime.prepare(async () => {
      const native = options.native ? new Fakes(join(root, "fake")) : undefined;
      const replies = acceptanceAgents();
      const fakes = native ?? {
        scenario(next: Scenario) {
          replies.configure({ builder: "plain", fixes: next.fixes, testerChecks: next.testerChecks, testerChecksFixed: next.testerChecksFixed,
            testerRuns: next.testerRuns, testerProofAnswers: next.testerProofAnswers });
        },
        openings: (role: string) => replies.openings(role.replaceAll(" ", "-")),
        marked: (_name: string) => { throw new Error("Marks need the native pause control"); },
      };
      // With `github`, a local folder stands in for the product's GitHub repository, holding main as the task started.
      const github = options.github ? join(root, "github.git") : undefined;
      // Saved maintenance profiles also read startup tool availability: every tool here is a stand-in.
      const engineOptions = { ...(native ? { agentCommand: () => [process.execPath, join(TEST_FIXTURE_ROOT, "fake-agent.ts"), native.dir], toolPath: () => process.execPath }
        : { startAgentSession: replies.start, toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" }, node: { status: "ready" } }) }),
        terminals: () => [], ...(github ? { remote: github } : {}) };
      const engine = lifetime.open(join(root, "data"), engineOptions);
      engine.schedule = () => {};
      await engine.waitUntilReady();
      if (!native) await engine.checkTools();
      engine.setPoolPaused(false);
      const products: DeepMutable<Product>[] = [];
      for (let i = 0; i < (options.shared ? 2 : 1); i++) {
        const dir = join(root, `product-${i}`); mkdirSync(dir);
        const repo = await makeProduct(dir, { origin: "none" });
        const id = installPreparedProduct(engine, { id: i === 0 ? "clone" : "clone-2", path: repo, name: `Product ${i + 1}`, repo: "local/clone",
          tone: i === 0 ? "blue" : "green", defaultBranch: "main", delivery: "local", approveDelivery: false });
        engine.setProductChecks(id, [{ name: "Test", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) }]);
        const product = engine.s.products.find(product => product.id === id)!;
        if (github) {
          // As after Petrina's earlier reads of GitHub's main, the product's copy knows where it is.
          await git(root, "init", "-q", "--bare", github); await git(repo, "push", "-q", github, "HEAD:refs/heads/main");
          await git(repo, "fetch", "-q", github, "+refs/heads/main:refs/remotes/origin/main");
          product.repo = "acme/greeting"; product.remote = "https://github.com/acme/greeting.git";
        }
        products.push(product);
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
      if (options.shared) { delete task.repository; task.repositories = owners; task.activeProductId = products[0]!.id; }
      else task.repository = owners[0];
      const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
      const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
      const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
      const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
      // Petrina finds the acceptance role by its checks result, whatever it is called or wherever it is defined.
      if (options.role && options.role !== "built-in") {
        const role = { ...engine.role("tester")!, id: "quality-partner", name: "Quality partner" };
        if (options.role === "custom") engine.s.roles.push(role);
        else task.maintenance = { routineId: "routine", routineName: "Weekly check", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Try the greeting", input: "Try the greeting", role, profile: engine.s.profiles.find(profile => profile.id === "opus-high")!, product: products[0]! };
        tester.roleId = role.id;
      }
      task.plan = { rationale: "Focused acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, ship] };
      task.approveDelivery = false;
      const checklist = options.checklist ?? [required];
      if (checklist.length) task.brief = { summary: "Show the greeting", areas: [], forUsers: [], risks: [], acceptance: checklist.map(text => ({ text })) };
      task.state = "running"; task.stageIndex = 1;
      const f = {
        root, fakes, engine, task, close, scope: executionFor(task), products, owners, build, tester, review, ship, github,
        testerName: tester.roleId === "tester" ? "tester" : "quality partner",
        mains: () => lifetime.run(f.engine, () => completeAll(products.map(product => git(product.path!, "rev-parse", "main")))),
        drive: async () => {
          const admit = spyOn(f.engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(true);
          try { f.task.state = "running"; await lifetime.run(f.engine, () => f.engine["driver"].workflow["drive"](f.task.id)); if (f.engine.task(f.task.id)?.state === "failed") throw new Error(f.task.error); }
          finally { admit.mockRestore(); }
        },
        decisions: () => f.engine.s.inbox.filter(item => item.taskId === f.task.id && item.kind === "delivery"),
        runs: (roleId = tester.roleId) => f.task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId),
        /** Petrina quits and starts again on the same saved state. */
        restart: () => lifetime.prepare(async () => {
          const previous = f.engine;
          previous.setPoolPaused(true); await lifetime.stop(previous);
          const replacement = lifetime.open(previous.dataDir, engineOptions);
          f.engine = replacement;
          replacement.schedule = () => {};
          await replacement.waitUntilReady(); replacement.setPoolPaused(false);
          f.task = replacement.task(task.id)!; f.scope = executionFor(f.task);
        }),
      };
      return f;
    }), close);
  }

  return { fixture, close };
}
