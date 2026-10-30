import { describe, expect, it } from "vitest";
import {
  configureProductRemoteChecks,
  evaluateRemoteCheckGate,
  normalizeRemoteChecks,
  REMOTE_CHECK_LIMITS,
  type DeepMutable,
  type Product,
  type RemoteCheckSettingWork,
} from "../../../src/index.js";

describe("remote GitHub check declarations and exact-commit gate evaluation", () => {
  it("normalizes check names and rejects empty, multiline, duplicate, and oversized entries", () => {
    expect(normalizeRemoteChecks(["  Tests  ", "Build (macOS)"])).toEqual(["Tests", "Build (macOS)"]);
    expect(normalizeRemoteChecks([])).toEqual([]);
    expect(() => normalizeRemoteChecks(["Tests", "  "])).toThrow("Give every GitHub check a name.");
    expect(() => normalizeRemoteChecks(["Tests\nLint"])).toThrow("Keep each GitHub check name on a single line.");
    expect(() => normalizeRemoteChecks(["Tests", "Tests"])).toThrow("Each GitHub check name can appear only once");
    expect(() => normalizeRemoteChecks(["x".repeat(REMOTE_CHECK_LIMITS.name + 1)])).toThrow("120 characters");
    expect(() =>
      normalizeRemoteChecks(Array.from({ length: REMOTE_CHECK_LIMITS.count + 1 }, (_, i) => `Check ${i}`)),
    ).toThrow("20 or fewer");
  });

  it("invalidates unpublished preparations and approvals without disturbing admitted or published deliveries", () => {
    const product: DeepMutable<Pick<Product, "id" | "requiredRemoteChecks">> = { id: "shop" };
    const unpublished: RemoteCheckSettingWork = {
      productId: "shop",
      approvedSha: "a".repeat(40),
      approvedPatch: "patch-1",
      approvedFor: { mode: "local", destination: "acme/shop#main", by: "coordinator" },
      shipping: {
        moves: 0,
        failures: 0,
        prepared: { tested: "a".repeat(40), summary: "Ready" },
        remoteValidation: { ref: "refs/heads/petrina/validation/t-1", sha: "a".repeat(40), pushed: true, verifiedAt: 10 },
      },
    };
    const midStep: RemoteCheckSettingWork = {
      productId: "shop",
      approvedSha: "b".repeat(40),
      shipping: {
        moves: 0,
        failures: 0,
        step: "push",
        prepared: { tested: "b".repeat(40), summary: "Pushing" },
        remoteValidation: { ref: "refs/heads/petrina/validation/t-2", sha: "b".repeat(40), pushed: true, verifiedAt: 20 },
      },
    };
    const published: RemoteCheckSettingWork = {
      productId: "shop",
      approvedSha: "c".repeat(40),
      landed: { branch: "main", sha: "c".repeat(40) },
    };

    expect(configureProductRemoteChecks(product, ["Tests"], [unpublished, midStep, published])).toBe(true);
    expect(product.requiredRemoteChecks).toEqual(["Tests"]);
    expect(unpublished.shipping?.prepared).toBeUndefined();
    expect(unpublished.shipping?.remoteValidation).toBeUndefined();
    expect(unpublished.approvedSha).toBeUndefined();
    expect(midStep.shipping?.prepared?.tested).toBe("b".repeat(40));
    expect(midStep.shipping?.remoteValidation?.verifiedAt).toBe(20);
    expect(published.approvedSha).toBe("c".repeat(40));

    expect(configureProductRemoteChecks(product, ["  Tests "], [unpublished])).toBe(false);
    expect(configureProductRemoteChecks(product, [], [unpublished])).toBe(true);
    expect(product.requiredRemoteChecks).toBeUndefined();
  });

  it("evaluates check-runs and commit statuses on the exact candidate SHA with suite deduplication", () => {
    const sha = "a".repeat(40);
    const olderSha = "0".repeat(40);

    expect(evaluateRemoteCheckGate([], { sha, checkRuns: [], statuses: [] })).toEqual({ kind: "passed" });

    expect(
      evaluateRemoteCheckGate(["Tests", "Preview"], {
        sha,
        checkRuns: [
          { id: 1, name: "Tests", status: "completed", conclusion: "failure", headSha: olderSha, appId: 1, suiteId: 10 },
          { id: 2, name: "Tests", status: "in_progress", headSha: sha, appId: 1, suiteId: 10 },
        ],
        statuses: [],
      }),
    ).toEqual({
      kind: "pending",
      waitingOn: ["Tests", "Preview"],
      summary: "Waiting for GitHub checks: Tests, Preview",
    });

    // Fails immediately when one required check fails even while another is still running.
    expect(
      evaluateRemoteCheckGate(["Tests", "Preview"], {
        sha,
        checkRuns: [{ id: 2, name: "Tests", status: "in_progress", headSha: sha }],
        statuses: [{ id: 1, context: "Preview", state: "failure", description: "Deploy failed" }],
      }),
    ).toMatchObject({
      kind: "failed",
      failed: [{ name: "Preview", reason: "failed on GitHub (Deploy failed)" }],
    });

    // Re-run within the same (appId, suiteId, name) supersedes an earlier failure,
    // while two distinct suites sharing the same check name must both pass.
    expect(
      evaluateRemoteCheckGate(["Tests", "Shared"], {
        sha,
        checkRuns: [
          {
            id: 1,
            name: "Tests",
            status: "completed",
            conclusion: "failure",
            headSha: sha,
            appId: 1,
            suiteId: 10,
            timestamp: "2026-10-30T10:00:00Z",
          },
          {
            id: 2,
            name: "Tests",
            status: "completed",
            conclusion: "success",
            headSha: sha,
            appId: 1,
            suiteId: 10,
            timestamp: "2026-10-30T10:05:00Z",
          },
          { id: 3, name: "Shared", status: "completed", conclusion: "success", headSha: sha, appId: 1, suiteId: 10 },
          { id: 4, name: "Shared", status: "completed", conclusion: "failure", headSha: sha, appId: 1, suiteId: 20 },
        ],
        statuses: [],
      }),
    ).toMatchObject({
      kind: "failed",
      failed: [{ name: "Shared", reason: "failed on GitHub" }],
    });

    // A required check that completed only as skipped does not satisfy the gate.
    expect(
      evaluateRemoteCheckGate(["Release gate"], {
        sha,
        checkRuns: [{ id: 1, name: "Release gate", status: "completed", conclusion: "skipped", headSha: sha }],
        statuses: [],
      }),
    ).toMatchObject({
      kind: "failed",
      failed: [{ name: "Release gate", reason: "was skipped on GitHub instead of passing" }],
    });

    // Passes when every required check-run and commit status succeeded on the candidate SHA.
    expect(
      evaluateRemoteCheckGate(["Tests", "Preview"], {
        sha,
        checkRuns: [{ id: 2, name: "Tests", status: "completed", conclusion: "success", headSha: sha }],
        statuses: [
          { id: 1, context: "Preview", state: "pending", timestamp: "2026-10-30T10:00:00Z" },
          { id: 2, context: "Preview", state: "success", timestamp: "2026-10-30T10:01:00Z" },
        ],
      }),
    ).toEqual({ kind: "passed" });
  });
});
