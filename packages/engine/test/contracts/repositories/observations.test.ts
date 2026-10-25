import { afterAll, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameVersions } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { git } from "@petrina/test-support/commands";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import * as operations from "../../../src/git.js";
import { committedCodeOf } from "../../../src/repositories.js";
import { repositoryObservationQueries } from "../../../src/repository-observations.js";
import { observationRepository, observationTask } from "../../fixtures/repository-observations.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const folder = () => { const root = tempDir("repository-observations-"); roots.push(root); return root; };

for (const format of ["sha1", "sha256"] as const) it(`pins ${format} fingerprints and workspace ownership without cleaning uncommitted contents`, async () => {
  const root = folder(), { path, base, task } = await observationRepository(root, format);
  const scope = executionFor(task), reader = repositoryObservationQueries.bind(scope)!;
  writeFileSync(join(path, "README.md"), "First change\n");
  const head = (await operations.commitAll(path, "First change"))!;
  const version = await reader.committed();
  expect(version).toEqual({ head, tree: await git(path, "rev-parse", "HEAD^{tree}") });
  expect(version!.head).toHaveLength(format === "sha256" ? 64 : 40);
  const change = (await operations.patchId(path, base, head))!;
  expect(change).toMatch(/^[0-9a-f]{64}$/);
  expect(await committedCodeOf(task)).toEqual({ versions: { product: version!.tree }, changes: { product: change } });

  writeFileSync(join(path, "README.md"), "Later committed code\n");
  const later = (await operations.commitAll(path, "Later change"))!, laterTree = await git(path, "rev-parse", "HEAD^{tree}");
  writeFileSync(join(path, "README.md"), "Uncommitted work\n");
  writeFileSync(join(path, "untracked.txt"), "Owned output\n");
  const status = await operations.worktreeStatus(path);
  expect(status).toEqual({ head: later, clean: false, trackedChanged: true });
  expect(await committedCodeOf(task)).toEqual({ versions: { product: laterTree }, changes: { product: (await operations.patchId(path, base, later))! } });

  // A reader stays on the workspace it bound, even after task metadata points elsewhere.
  scope.work.worktree = join(root, "not-the-workspace");
  expect(await reader.change(base, version!.head)).toBe(change);
  expect(await reader.change(base, later)).not.toBe(change);
  expect(await reader.committed()).toEqual({ head: later, tree: laterTree });
  expect(await operations.worktreeStatus(path)).toEqual(status);
  expect(readFileSync(join(path, "README.md"), "utf8")).toBe("Uncommitted work\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("Owned output\n");
});

it("does not invent a version for an unprepared, non-repository or unborn workspace", async () => {
  const root = folder(), task = observationTask(), scope = executionFor(task);
  expect(repositoryObservationQueries.bind(scope)).toBeUndefined();
  expect(await committedCodeOf(task)).toEqual({ versions: { product: "unavailable" }, changes: { product: "unavailable" } });
  const path = join(root, "empty"); mkdirSync(path); scope.work.worktree = path;
  const reader = repositoryObservationQueries.bind(scope)!;
  expect(await reader.committed()).toBeUndefined();
  await git(path, "init", "-q", "-b", "main");
  expect(await reader.committed()).toBeUndefined();
  const unavailable = await committedCodeOf(task);
  expect(unavailable).toEqual({ versions: { product: "unavailable" }, changes: { product: "unavailable" } });
  expect(sameVersions(unavailable.versions, unavailable.versions)).toBe(false);

  writeFileSync(join(path, "README.md"), "Committed without a starting base\n");
  await operations.commitAll(path, "Initial");
  const tree = await git(path, "rev-parse", "HEAD^{tree}");
  expect(await committedCodeOf(task)).toEqual({ versions: { product: tree }, changes: { product: "unavailable" } });
  scope.work.baseSha = "not-a-commit";
  expect(await committedCodeOf(task)).toEqual({ versions: { product: tree }, changes: { product: "unavailable" } });
});
