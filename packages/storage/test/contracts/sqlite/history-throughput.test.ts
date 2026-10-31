import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { throughputTaskRecord } from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { historyState as state, historyTask as task } from "../../../../core/test/fixtures/history-records.js";

const folders: string[] = [];
afterAll(() => folders.forEach(removeDir));

function store(): { file: string; db: Store } {
  const folder = tempDir("petrina-history-throughput-");
  folders.push(folder);
  const file = join(folder, "history.db");
  return { file, db: new Store(file) };
}

describe("TaskHistory bounded throughput projection", () => {
  it("projects single and shared archived tasks via time and membership indexes without reading conversations or check output, including legacy pre-column rows under query_only", () => {
    const { db } = store();
    try {
      const richSingle = task(10, {
        productId: "one",
        createdAt: 1_000,
        startedAt: 2_000,
        finishedAt: 9_000,
        sentBack: 1,
        session: [{ id: "huge-line", at: 2_500, from: "agent", text: "Private transcript ".repeat(500) }],
        runtimeWait: {
          after: [],
          reason: "waited",
          releasedAt: 1_800,
          changes: [
            { at: 1_200, before: [], after: ["dep-1"], reason: "waited" },
            { at: 1_800, before: ["dep-1"], after: [], reason: "released" },
          ],
        },
        plan: {
          plannerProfileId: "sonnet-medium",
          rationale: "Long rationale",
          stages: [
            { id: "s-build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
            { id: "s-review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
          ],
        },
        repository: {
          productId: "one",
          delivery: "pull-request",
          pr: { number: 42, url: "https://github.com/acme/one/pull/42", state: "merged", openedAt: 8_000 },
          confirmedDelivery: { sha: "sha-42", tree: "tree-42", repo: "acme/one", branch: "main", at: 9_000 },
        },
        journey: [
          {
            id: "step-1",
            kind: "agent",
            stageId: "s-build",
            round: 1,
            sub: 0,
            roleId: "builder",
            startedAt: 2_000,
            endedAt: 5_000,
            end: "done",
            asks: [{ id: "ask-p", kind: "permission", title: "Run tool", at: 2_500, endedAt: 3_000 }],
            agentInputs: [
              {
                at: 2_100,
                roleId: "builder",
                profileId: "sol-high",
                taskTitle: "Task 10",
                mode: "fresh",
                sections: [{ title: "Huge prompt", body: "Prompt body ".repeat(500) }],
                readiness: {
                  toolId: "codex",
                  at: 2_010,
                  previous: { status: "unknown" },
                  check: "started",
                  outcome: "ready",
                },
              },
            ],
            checkReasons: [{ attemptId: "run-1", productId: "one", purpose: "review", changed: ["code"] }],
            productChecks: [
              {
                id: "run-1:test",
                attemptId: "run-1",
                productId: "one",
                name: "Tests",
                result: "fail",
                queuedAt: 5_000,
                startedAt: 5_100,
                endedAt: 5_900,
                run: {
                  name: "Tests",
                  command: "bun test",
                  ok: false,
                  ms: 800,
                  startedAt: 5_100,
                  endedAt: 5_900,
                  output: "Large check stdout ".repeat(500),
                  source: { stepId: "step-1", attemptId: "run-1", checkId: "test" },
                  execution: {
                    started: true,
                    exit: { status: "reported", code: 1 },
                    stdout: "eof",
                    stderr: "eof",
                    timedOut: false,
                    cancelled: false,
                    cleanup: "not-requested",
                    outputCleanup: "not-requested",
                  },
                },
              },
            ],
            reuses: [{ at: 6_000, originalAt: 5_900, productId: "one", purpose: "review", basis: "same-tree", passed: false }],
          },
          {
            id: "step-2",
            kind: "agent",
            stageId: "s-build",
            round: 2,
            sub: 0,
            roleId: "builder",
            fixing: true,
            findingIds: ["f-1"],
            startedAt: 6_100,
            endedAt: 7_500,
            end: "done",
            trigger: { after: "step-1", reason: "checks failed" },
            builderReturn: { changed: true, productId: "one", claimedFixes: 1, outcome: "Fixed check failure" },
            checkRepairs: [
              {
                productId: "one",
                failureNode: "step-1",
                checkId: "test",
                attemptId: "run-1",
                findingId: "f-check",
                sha: "sha-42",
                tree: "tree-42",
                definition: "def-1",
                commands: ["bun test"],
                answer: { fixed: true, text: "Fixed failure" },
              },
            ],
            result: { findingChanges: { raised: [], fixed: [], dismissed: [], reopened: [{ id: "f-0", evidence: true }] } },
          },
        ],
      });

      const sharedTask = task(20, {
        productId: "one",
        createdAt: 3_000,
        startedAt: 4_000,
        finishedAt: 12_000,
        repositories: [
          {
            productId: "one",
            delivery: "local",
            completedStages: [],
            landed: { branch: "main", sha: "sha-one" },
            confirmedDelivery: { sha: "sha-one", tree: "tree-one", repo: "acme/one", branch: "main", at: 11_500 },
          },
          {
            productId: "two",
            delivery: "local",
            completedStages: [],
            nothingToPublish: true,
          },
        ],
      });

      const olderOutsideWindow = task(1, {
        productId: "two",
        createdAt: 100,
        startedAt: 200,
        finishedAt: 500,
      });

      db.save(state([olderOutsideWindow, richSingle, sharedTask]));

      // Refuse full-body reads on `db.history.get`.
      const origGet = db.history.get.bind(db.history);
      db.history.get = (id) => {
        throw new Error(`Unexpected full task body read: ${id}`);
      };

      try {
        const expectedRich = throughputTaskRecord(richSingle);
        const expectedShared = throughputTaskRecord(sharedTask);
        const expectedOld = throughputTaskRecord(olderOutsideWindow);

        const allInWindow = db.history.throughputTasks({ from: 5_000 });
        expect(allInWindow).toEqual([expectedShared, expectedRich]);
        expect(JSON.stringify(allInWindow)).not.toContain("Private transcript");
        expect(JSON.stringify(allInWindow)).not.toContain("Prompt body");
        expect(JSON.stringify(allInWindow)).not.toContain("Large check stdout");

        // Explicit taskIds fetches older tasks referenced by in-window turns/moments, respecting productId filter.
        const withExtraAll = db.history.throughputTasks({ from: 5_000, taskIds: [olderOutsideWindow.id] });
        expect(withExtraAll).toEqual([expectedShared, expectedRich, expectedOld]);

        const scopedTwo = db.history.throughputTasks({ from: 5_000, productId: "two", taskIds: [richSingle.id, olderOutsideWindow.id] });
        expect(scopedTwo).toEqual([expectedShared, expectedOld]);

        // Verify legacy pre-column rows (`throughput IS NULL`) produce the exact same record under `PRAGMA query_only = ON`.
        db.database.run("UPDATE task_history SET throughput = NULL");
        db.database.run("PRAGMA query_only = ON");
        try {
          const legacyRecords = db.history.throughputTasks({ from: 5_000, taskIds: [olderOutsideWindow.id] });
          expect(legacyRecords).toEqual([expectedShared, expectedRich, expectedOld]);
        } finally {
          db.database.run("PRAGMA query_only = OFF");
        }

        // Verify query plans use time and membership indexes without a TEMP B-TREE sort.
        const unfilteredPlan = db.database
          .query<{ detail: string }, []>(
            "EXPLAIN QUERY PLAN SELECT h.id, h.throughput FROM task_history h WHERE h.finished_at >= 5000 ORDER BY h.finished_at DESC, h.id DESC",
          )
          .all();
        expect(unfilteredPlan.some((row) => row.detail.includes("task_history_newest"))).toBe(true);
        expect(unfilteredPlan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);

        const productPlan = db.database
          .query<{ detail: string }, []>(
            "EXPLAIN QUERY PLAN SELECT h.id, h.throughput FROM task_history_products p JOIN task_history h ON h.id = p.task_id WHERE p.product_id = 'one' AND p.finished_at >= 5000 ORDER BY p.finished_at DESC, p.task_id DESC",
          )
          .all();
        expect(productPlan.some((row) => row.detail.includes("task_history_membership_newest"))).toBe(true);
        expect(productPlan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
      } finally {
        db.history.get = origGet;
      }

      // Removing product "one" drops `richSingle` and updates retained `sharedTask` to product "two" only.
      db.removeProduct("one", { ...state([]), products: state([]).products.filter((p) => p.id !== "one") });
      expect(db.history.throughputTasks({ from: 0, productId: "one" })).toEqual([]);
      const remainingTwo = db.history.throughputTasks({ from: 0, productId: "two" });
      expect(remainingTwo.map((entry) => entry.id)).toEqual([sharedTask.id, olderOutsideWindow.id]);
      expect(remainingTwo[0]!.productIds).toEqual(["two"]);
    } finally {
      db.close();
    }
  });
});
