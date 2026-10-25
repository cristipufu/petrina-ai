import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryView } from "@petrina/orchestrator";
import { prepareReviewInput, readReviewInput, reviewBases, reviewBaseUpdates } from "../../../src/review-context.js";
import { git } from "../../fixtures.js";
import { reviewContextFixtures } from "../../fixtures/review-context.js";
const { bare, earlier, close } = reviewContextFixtures();
afterAll(close);

describe("immutable review inputs", () => {
it("prepares only port comparisons and keeps lockfile evidence out of the inline port material", async () => {
    const f = await bare();
    try {
      writeFileSync(join(f.repo, "bun.lock"), "PORT-LOCKFILE-SENTINEL\n".repeat(1_000));
      mkdirSync(join(f.repo, "packages", "[new]"), { recursive: true });
      writeFileSync(join(f.repo, "packages", "[new]", "package-lock.json"), "NESTED-PORT-LOCKFILE\n");
      writeFileSync(join(f.repo, "greeting.txt"), "A-PORTED-GREETING\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Resolve the port");
      const head = await git(f.repo, "rev-parse", "HEAD");
      f.scope.work.portReview = { from: f.base, head: f.first, onto: f.first, files: ["greeting.txt", "bun.lock", "packages/[new]/package-lock.json"] };
      f.scope.work.reviewedSha = f.first;
      const run = spyOn(gitOps, "run");
      try {
        const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
        const input = await readReviewInput(ref);
        const full = readFileSync(input.artifacts![0]!.file, "utf8");
        expect(full).toContain("A-PORTED-GREETING"); expect(full).toContain("bun.lock"); expect(full).not.toContain("PORT-LOCKFILE-SENTINEL");
        expect(full).toContain("packages/[new]/package-lock.json"); expect(full).not.toContain("NESTED-PORT-LOCKFILE");
        expect(full).not.toContain("## Complete change");
        expect(input.artifacts!.some((file) => file.file.endsWith(".incremental.md"))).toBe(false);
        const locks = input.artifacts!.find((file) => file.file.endsWith(".port-lockfiles.md"))!;
        expect(readFileSync(locks.file, "utf8")).toContain("PORT-LOCKFILE-SENTINEL");
        expect(readFileSync(locks.file, "utf8")).toContain("NESTED-PORT-LOCKFILE");
        expect(run.mock.calls.some(([args]) => args.includes(`${f.base}...${head}`))).toBe(false);
      } finally { run.mockRestore(); }
    } finally { await f.engine.shutdown(); }
  });
});

describe("immutable review inputs", () => {
for (const empty of ["old", "new", "both"]) it(`prepares a port whose ${empty} commit range is empty`, async () => {
    const f = await bare();
    try {
      f.scope.work.portReview = { from: f.base, head: empty === "new" ? f.first : f.base, onto: empty === "old" ? f.base : f.first, files: ["greeting.txt"] };
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      const input = await readReviewInput(ref);
      const body = readFileSync(input.artifacts![0]!.file, "utf8");
      expect(body).toContain("No commits in this range.");
      if (empty !== "both") expect(body).toContain("+FIRST-CHANGE");
    } finally { await f.engine.shutdown(); }
  });
});

describe("immutable review inputs", () => {
it("keeps earlier facts frozen while delivering new coordinator notes, including after saving and reopening the input", async () => {
    const f = await bare();
    try {
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      f.task.findings[0]!.status = "open"; f.task.findings[0]!.confirmedBy.push("opus-high");
      f.task.findings.push({ ...structuredClone(earlier), id: "peer", text: "PEER-THIS-ROUND", status: "open" });
      f.task.brief!.summary = "Changed after the round began";
      f.scope.work.report!.summary = "A changed Builder report";
      f.task.notes = [{ at: 2, text: "NEW-COORDINATOR-INSTRUCTION" }];
      const frozen = await readReviewInput(ref);
      const sections = await f.context.sectionsFor(f.scope, "code-reviewer", "review-1", undefined, undefined, frozen);
      const text = sections.map((section) => section.body).join("\n");
      expect(text).toContain("Frozen brief"); expect(text).toContain("Original Builder report");
      expect(text).toContain("(fixed)"); expect(text).toContain("NEW-COORDINATOR-INSTRUCTION");
      expect(text).not.toContain("PEER-THIS-ROUND"); expect(text).not.toContain("Changed after the round began");
      expect(frozen.findings[0]!.confirmedBy).toEqual([]);
      expect(ref.heads.p).toBe(f.first);
      expect(text).not.toContain("+FIRST-CHANGE");
    } finally { await f.engine.shutdown(); }
  });
});

describe("immutable review inputs", () => {
it("prepares exact full and incremental comparisons with the base guide, independently of later refs and worktree edits", async () => {
    const f = await bare();
    try {
      f.scope.work.reviewedSha = f.first;
      writeFileSync(join(f.repo, "greeting.txt"), "FIRST-CHANGE\nFIX-ONLY\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Fix the greeting");
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      const snapshot = await readReviewInput(ref);
      const file = /: ("[^"\n]+\.md") \(reference/.exec(snapshot.material!.body)![1]!;
      const body = readFileSync(JSON.parse(file), "utf8");
      expect(body).toContain(`git diff ${f.base}...${ref.heads.p}`);
      expect(body).not.toContain("## Changes since the last completed code-review round");
      const guide = body.split("## Complete change")[0]!;
      expect(guide).toContain("Preserve the original rule.");
      expect(guide).not.toContain("A change cannot replace the original rule.");
      const incremental = snapshot.artifacts!.find((artifact) => artifact.file.endsWith(".incremental.md"))!;
      const delta = readFileSync(incremental.file, "utf8");
      expect(delta).toContain(`git diff ${f.first}..${ref.heads.p}`);
      expect(delta).toContain("+FIX-ONLY"); expect(delta).not.toContain("+FIRST-CHANGE");
      writeFileSync(join(f.repo, "REVIEW.md"), "MUTATED-WORKTREE-GUIDE");
      expect(readFileSync(JSON.parse(file), "utf8")).toBe(body);
      expect(JSON.stringify(repositoryView(f.scope))).not.toContain("+FIX-ONLY");
    } finally { await f.engine.shutdown(); }
  });
});

describe("immutable review inputs", () => {
it("keeps lockfile patches separate, with paths in the statistics and the complete evidence available", async () => {
    const f = await bare();
    try {
      f.scope.work.reviewedSha = f.first;
      writeFileSync(join(f.repo, "bun.lock"), "LOCKFILE-ONLY-SENTINEL\n".repeat(5_000));
      writeFileSync(join(f.repo, "greeting.txt"), "FIRST-CHANGE\nFIX-ONLY\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Update a dependency and the greeting");
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      const input = await readReviewInput(ref);
      const ordinary = input.artifacts!.filter((artifact) => !artifact.file.endsWith("-lockfiles.md"));
      const locks = input.artifacts!.filter((artifact) => artifact.file.endsWith("-lockfiles.md"));
      expect(ordinary).toHaveLength(2); expect(locks).toHaveLength(2);
      for (const artifact of ordinary) {
        const text = readFileSync(artifact.file, "utf8");
        expect(text).toContain("bun.lock"); expect(text).not.toContain("LOCKFILE-ONLY-SENTINEL");
        expect(text).toContain("These changes remain in review scope");
      }
      for (const artifact of locks) expect(readFileSync(artifact.file, "utf8")).toContain("+LOCKFILE-ONLY-SENTINEL");
      const delta = readFileSync(ordinary.find((artifact) => artifact.file.endsWith(".incremental.md"))!.file, "utf8");
      expect(delta).toContain("+FIX-ONLY"); expect(delta).not.toContain("+FIRST-CHANGE");
      expect(input.material!.body).toContain("never excluded from review scope");
    } finally { await f.engine.shutdown(); }
  });
});

describe("immutable review inputs", () => {
it("prepares each shared product's own base guide and comparison, and rejects a damaged artifact", async () => {
    const a = await bare(), b = await bare();
    try {
      b.scope.work.productId = "second";
      a.task.repositories = [a.scope.work, b.scope.work].map((work) => ({ ...work, completedStages: [] }));
      const input = await a.context.captureReview(a.scope);
      const ref = await prepareReviewInput(a.engine.dataDir, a.scope, input, new AbortController().signal);
      const snapshot = await readReviewInput(ref);
      expect(ref.heads).toEqual({ p: a.first, second: b.first });
      expect(snapshot.artifacts).toHaveLength(2);
      const sections = await a.context.sectionsFor(a.scope, "code-reviewer", "review-0", { p: "/own/a", second: "/own/b" }, undefined, snapshot);
      expect(sections[0]!.body).toContain("copy: /own/a"); expect(sections[0]!.body).toContain("copy: /own/b");
      for (const artifact of snapshot.artifacts!) expect(readFileSync(artifact.file, "utf8")).toContain("Preserve the original rule.");
      for (const artifact of snapshot.artifacts!) {
        const original = readFileSync(artifact.file, "utf8");
        writeFileSync(artifact.file, "corrupt");
        await expectRejection(readReviewInput(ref), "prepared review comparison changed");
        writeFileSync(artifact.file, original);
      }
      expect(await readReviewInput(ref)).toEqual(snapshot);
    } finally { await a.engine.shutdown(); await b.engine.shutdown(); }
  });
});

it("checks each seat's remembered bases, including missing, unchanged, forward, port and incompatible anchors", async () => {
  const f = await bare();
  try {
    const bases = reviewBases(f.scope), heads = { p: f.first };
    expect((await reviewBaseUpdates(f.scope, bases, heads)).sections).toEqual([]);
    expect((await reviewBaseUpdates(f.scope, undefined, heads)).reason).toContain("saved repository bases");
    f.scope.work.baseSha = f.first;
    const moved = await reviewBaseUpdates(f.scope, bases, heads);
    expect(moved.sections).toHaveLength(1);
    expect(moved.sections[0]!.body).toContain("No incremental comparison is available");
    f.scope.work.source = { product: { id: "p", name: "Product", repo: "local/product" }, start: { kind: "branch", branch: "release" }, destination: { mode: "local", repo: "local/product", branch: "release", kind: "branch" }, confirmed: true };
    f.scope.work.reviewedSha = f.first;
    const branch = await reviewBaseUpdates(f.scope, bases, heads);
    expect(branch.sections[0]!.body).toContain("release gained 1 commit.");
    expect(branch.sections[0]!.body).toContain("release's incoming changes are not in the incremental comparison");
    expect((await reviewBaseUpdates(f.scope, { p: f.first }, heads)).sections).toEqual([]);
    const unrelated = await git(f.repo, "commit-tree", `${f.first}^{tree}`, "-m", "A base without the original history");
    expect((await reviewBaseUpdates(f.scope, { p: unrelated }, heads)).reason).toContain("replaced or diverged");
    f.scope.work.portReview = { from: f.base, head: f.first, onto: f.first, files: ["greeting.txt"] };
    expect((await reviewBaseUpdates(f.scope, bases, heads)).reason).toContain("conflict port review");
  } finally { await f.engine.shutdown(); }
});
