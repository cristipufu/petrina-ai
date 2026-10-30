import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { githubService } from "@petrina/repositories/github-service";
import { waitFor } from "@petrina/test-support/fixtures";
import { ADDRESS, createProductRepository } from "@petrina/test-support/repositories";
import { Coordination } from "../../../src/coordination.js";
import type { MutableStage, RuntimeTask } from "../../../src/kernel.js";
import { candidateValidationBranch } from "../../../src/shipping-remote-ci.js";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { commitLooseOnRef, installSharedWorkflowFastPaths, readRef } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

interface CheckScenario {
  checkRunsFor(sha: string): readonly Record<string, unknown>[];
  onPoll?(sha: string, pollCount: number): Promise<void> | void;
}

async function setupDeliveryCase(owner: EngineCaseOwner, scenario: CheckScenario) {
  const repoRoot = join(owner.root, "repo");
  const { path: clone, initialSha } = await createProductRepository(repoRoot);
  const origin = join(repoRoot, "origin.git");
  const worktree = join(owner.root, "worktree");
  const branch = "petrina/task-1";
  await gitOps.ensureWorktree(clone, worktree, branch, initialSha);
  writeFileSync(join(worktree, "feature.txt"), "tested feature\n");
  if (!(await gitOps.commitChanges(worktree, "Add tested feature"))) {
    throw new Error("Expected initial task commit");
  }
  const candidateSha = (await gitOps.head(worktree))!;

  let pollCount = 0;
  const github = githubService({
    async request(args) {
      if (args[0] === "auth" && args[1] === "status") {
        return { code: 0, stdout: "Logged in to github.com", stderr: "" };
      }
      if (args[0] === "api") {
        const endpoint = args[1] ?? "";
        const runMatch = /^repos\/acme\/demo\/commits\/([0-9a-f]{40})\/check-runs/.exec(endpoint);
        if (runMatch) {
          const sha = runMatch[1]!;
          pollCount += 1;
          await scenario.onPoll?.(sha, pollCount);
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify([{ check_runs: scenario.checkRunsFor(sha) }]),
          };
        }
        if (endpoint.includes("/status?")) {
          return { code: 0, stderr: "", stdout: JSON.stringify([{ statuses: [] }]) };
        }
      }
      return { code: 1, stdout: "", stderr: `Unexpected gh request: ${args.join(" ")}` };
    },
  });

  const engine = installSharedWorkflowFastPaths(
    owner.open(join(owner.root, "data"), {
      admissionsClosed: false,
      toolProbe: privateAgentToolProbe(),
      agentCommand: () => undefined,
      usageCommands: { codex: null, grok: null, antigravity: null },
      remote: origin,
      github,
      remoteCheckPollMs: 10,
      remoteCheckTimeoutMs: 2_000,
    }),
  );
  engine.schedule = () => {};
  await engine.waitUntilReady();
  await Promise.all([...engine.backgroundWork]);

  engine.s.products.push({
    id: "demo",
    name: "Demo",
    repo: "acme/demo",
    remote: ADDRESS,
    tone: "blue",
    path: clone,
    defaultBranch: "main",
    delivery: "local",
    approveDelivery: false,
    checks: [],
    checksBy: "coordinator",
  });

  const taskId = engine.addTask({ productId: "demo", title: "Ship gated change", backlog: true });
  const task = engine.task(taskId)!;
  const shipStage: MutableStage = {
    id: "ship",
    title: "Deliver",
    kind: "do",
    roleId: "release-manager",
    profileIds: ["sol-high"],
  };
  task.state = "running";
  task.column = "ready";
  task.approveDelivery = false;
  task.plan = {
    rationale: "Build and deliver directly to main",
    plannerProfileId: "sol-high",
    stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      shipStage,
    ],
  };
  task.stageIndex = 1;
  const scope = executionFor(task);
  scope.work.delivery = "local";
  scope.work.worktree = worktree;
  scope.work.branch = branch;
  scope.work.baseSha = initialSha;
  scope.work.report = { summary: "Added tested feature", changes: ["Added tested feature"] };
  scope.work.checks = { sha: candidateSha, current: true, at: Date.now(), results: [] };
  scope.work.source = {
    product: {
      id: "demo",
      name: "Demo",
      repo: "acme/demo",
      remote: ADDRESS,
      path: clone,
      defaultBranch: "main",
    },
    start: { kind: "default", branch: "main" },
    destination: { mode: "local", kind: "branch", repo: "acme/demo", remote: ADDRESS, branch: "main" },
    confirmed: true,
  };

  return { engine, task, shipStage, clone, origin, worktree, initialSha, candidateSha };
}

describe("product-defined exact-candidate GitHub CI gate and concurrent destination reconciliation", () => {
  it("pushes a validation branch, waits for required GitHub checks before touching main, and lands once they pass", async () => {
    return cases.use("petrina-remote-ci-pass-", (owner) =>
      owner.prepare(async () => {
        let checkStatus: "in_progress" | "completed" = "in_progress";
        const f = await setupDeliveryCase(owner, {
          checkRunsFor: (sha) => [
            {
              id: 1,
              name: "Tests",
              status: checkStatus,
              conclusion: checkStatus === "completed" ? "success" : null,
              head_sha: sha,
            },
          ],
        });

        const coordination = new Coordination(f.engine);
        const setReply = await coordination.call("product.remote-checks", {
          productId: "demo",
          checks: ["Tests"],
          requestId: "set-remote-checks-1",
        });
        expect(setReply.outcome).toBe("completed");
        const listed = await coordination.call("product.list", {});
        expect(listed).toMatchObject({
          outcome: "completed",
          items: [expect.objectContaining({ id: "demo", requiredRemoteChecks: ["Tests"] })],
        });

        const delivering = owner.run(f.engine, () =>
          f.engine["shipping"].deliver(f.task, f.shipStage, f.engine.stopRequested.signal),
        );

        let testedSha = "";
        await waitFor(
          () => {
            const prepared = executionFor(f.task).work.shipping?.prepared?.tested;
            if (!prepared) return false;
            testedSha = prepared;
            const validationRef = `refs/heads/${candidateValidationBranch(f.task.id, prepared, 0)}`;
            return (
              readRef(f.origin, validationRef) === prepared
              && f.task.statusLine === "Waiting for GitHub checks: Tests"
            );
          },
          "validation ref push and GitHub check wait status",
          5_000,
        );

        // Neither the local main branch nor GitHub main may advance while remote CI is still running.
        expect(await gitOps.revParse(f.clone, "refs/heads/main")).toBe(f.initialSha);
        expect(readRef(f.origin, "refs/heads/main")).toBe(f.initialSha);

        checkStatus = "completed";
        expect(await delivering).toBe("stop");
        expect(f.task.state).toBe("done");
        expect(await gitOps.revParse(f.clone, "refs/heads/main")).toBe(testedSha);
        expect(readRef(f.origin, "refs/heads/main")).toBe(testedSha);
      }),
    );
  });

  it("blocks publication without moving local or remote main and routes back to the builder when a required GitHub check fails", async () => {
    return cases.use("petrina-remote-ci-fail-", (owner) =>
      owner.prepare(async () => {
        const f = await setupDeliveryCase(owner, {
          checkRunsFor: (sha) => [
            { id: 1, name: "Tests", status: "completed", conclusion: "failure", head_sha: sha },
          ],
        });
        f.engine.setProductRemoteChecks("demo", ["Tests"]);

        const result = await owner.run(f.engine, () =>
          f.engine["shipping"].deliver(f.task, f.shipStage, f.engine.stopRequested.signal),
        );
        expect(result).toBe("continue");
        expect(f.task.stageIndex).toBe(0);
        expect(f.task.fixing).toBe(true);
        expect(f.task.findings).toEqual([
          expect.objectContaining({
            kind: "delivery",
            severity: "blocking",
            status: "open",
            text: expect.stringContaining("GitHub check “Tests” failed on GitHub"),
          }),
        ]);
        expect(await gitOps.revParse(f.clone, "refs/heads/main")).toBe(f.initialSha);
        expect(readRef(f.origin, "refs/heads/main")).toBe(f.initialSha);
      }),
    );
  });

  it("reconciles via prepareAgain when main moves on GitHub during remote-CI validation and validates the rebased candidate", async () => {
    return cases.use("petrina-remote-ci-move-", (owner) =>
      owner.prepare(async () => {
        let firstTestedSha: string | undefined;
        let teammateSha: string | undefined;
        let f!: Awaited<ReturnType<typeof setupDeliveryCase>>;
        f = await setupDeliveryCase(owner, {
          onPoll(sha, count) {
            if (count === 1) {
              firstTestedSha = sha;
              teammateSha = commitLooseOnRef(f.origin, {
                ref: "refs/heads/main",
                file: { name: "teammate.txt", content: "teammate commit\n" },
                message: "Teammate change",
              });
              if (!teammateSha) throw new Error("Expected teammate commit on origin main");
            }
          },
          checkRunsFor: (sha) => [
            {
              id: 1,
              name: "Tests",
              status: sha === firstTestedSha ? "in_progress" : "completed",
              conclusion: sha === firstTestedSha ? null : "success",
              head_sha: sha,
            },
          ],
        });
        f.engine.setProductRemoteChecks("demo", ["Tests"]);

        // First pass observes main move on GitHub while the initial candidate's check is in progress.
        const firstPass = await owner.run(f.engine, () =>
          f.engine["shipping"].deliver(f.task as RuntimeTask, f.shipStage, f.engine.stopRequested.signal),
        );
        expect(firstPass).toBe("continue");
        const scope = executionFor(f.task);
        expect(scope.work.shipping?.moves).toBe(1);
        expect(readRef(f.origin, "refs/heads/main")).toBe(teammateSha);
        expect(await gitOps.revParse(f.clone, "refs/heads/main")).toBe(f.initialSha);

        // Second pass updates onto teammateSha, validates the new rebased candidate SHA on moves=1, and lands.
        const secondPass = await owner.run(f.engine, () =>
          f.engine["shipping"].deliver(f.task as RuntimeTask, f.shipStage, f.engine.stopRequested.signal),
        );
        expect(secondPass).toBe("stop");
        expect(f.task.state).toBe("done");
        const finalMain = readRef(f.origin, "refs/heads/main")!;
        expect(finalMain).not.toBe(firstTestedSha);
        expect(finalMain).not.toBe(teammateSha);
        expect(await gitOps.contains(f.clone, finalMain, teammateSha!)).toBe(true);
        const rebasedValidationRef = `refs/heads/${candidateValidationBranch(f.task.id, finalMain, 1)}`;
        expect(readRef(f.origin, rebasedValidationRef)).toBe(finalMain);
      }),
    );
  });
});
