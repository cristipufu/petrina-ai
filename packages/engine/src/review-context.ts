import { reviewConversationScope as projectReviewScope } from "@petrina/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BuilderContext, Finding, Hunt, Id, Role, Task } from "@petrina/core";
import type { Section } from "./context.js";
import type { ContextPart } from "./roles.js";
import { repositoryView, scopesFor, type RepositoryContext } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { saveImmutable } from "./immutable-file.js";
import { freezeReviewHistory, readReviewHistory, type CompactReviewHistory, type StoodThrough } from "./review-history.js";

import { PREPARED_REVIEW } from "./prompts.js";
export interface ReviewInput {
  proofs?: readonly Section[];
  parts: Partial<Record<ContextPart, readonly Section[]>>;
  source: readonly Section[];
  products?: readonly { productId: Id; beforeCopy: string; copy: string; afterCopy: string }[];
  handedBack: readonly Section[];
  cards: readonly { id: Id; title: string; problem: string; productIds?: readonly Id[] }[];
  findings: readonly Finding[];
  /** Eligibility captured with the baseline, never reconstructed from later live state. */
  settled?: Readonly<Record<Id, StoodThrough>>;
  history?: CompactReviewHistory;
  material?: Section;
  artifacts?: readonly { file: string; digest: string }[];
}
type InputRef = NonNullable<Hunt["input"]>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const immutable = (folder: string, suffix: string, body: string) => saveImmutable(folder, suffix, body, "The saved review material changed. Try the review again.");

async function output(path: string, args: string[]): Promise<string> {
  const result = await git.run(["git", ...args], path, undefined, { timeoutMs: 30_000, rawOutput: true });
  if (result.code !== 0) throw new Error(`Could not prepare the review comparison: ${result.stderr || "Git did not finish"}`);
  return result.stdout;
}

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const EXCLUDE_LOCKS = LOCKFILES.map((name) => `:(glob,exclude)**/${name}`);
const ONLY_LOCKS = LOCKFILES.map((name) => `:(glob)**/${name}`);
async function comparison(path: string, range: string, files?: readonly string[]) {
  if (files?.length === 0) return { stat: "", patch: "", locks: "" };
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", range, "--"];
  const selected = files?.map((file) => `:(literal)${file}`) ?? ["."];
  const lockPaths = files ? files.filter((file) => LOCKFILES.includes(basename(file))).map((file) => `:(literal)${file}`) : ONLY_LOCKS;
  const [stat, patch, locks] = await Promise.all([
    output(path, ["diff", "--no-ext-diff", "--stat", range, "--", ...selected]),
    output(path, [...args, ...selected, ...EXCLUDE_LOCKS]),
    lockPaths.length ? output(path, [...args, ...lockPaths]) : "",
  ]);
  return { stat, patch, locks };
}

/** Resolve each comparison once, before any reviewer reports. Raw code never enters task/window state. */
export async function prepareReviewInput(dataDir: string, scope: RepositoryContext, input: ReviewInput, signal: AbortSignal): Promise<InputRef> {
  const { task } = scope;
  const folder = join(dataDir, "contexts", task.id, "reviews");
  const heads: Record<Id, string> = {};
  const trees: Record<Id, string> = {};
  const materials: string[] = [];
  const artifacts: { file: string; digest: string }[] = [];
  for (const work of task.repositories ?? [scope.work]) {
    signal.throwIfAborted();
    const path = work.worktree!;
    const head = await git.head(path), base = work.baseSha ?? work.base!;
    heads[work.productId] = head;
    const tree = await git.treeOf(path, head);
    if (tree) trees[work.productId] = tree;
    const full = `${base}...${head}`;
    const delta = !work.portReview && work.reviewedSha ? `${work.reviewedSha}..${head}` : undefined;
    const [guide, change, fixes] = await Promise.all([
      git.fileAt(path, base, "REVIEW.md"),
      work.portReview ? undefined : comparison(path, full),
      delta ? comparison(path, delta) : undefined,
    ]);
    const header = `# Review material for ${work.source?.product.name ?? work.productId}\nProduct: ${work.productId}\nBase: ${base}\nReviewed commit: ${head}`;
    const rules = `## Review guide at the saved base\n${guide ?? "This base has no REVIEW.md."}\nThe change's own review-guide edits do not change these rules.`;
    const lockFiles: { file: string; digest: string }[] = [];
    const lockMaterial = async (patch: string, label: string): Promise<string> => {
      if (!patch) return "";
      const saved = await immutable(folder, `${label}-lockfiles.md`, `${header}\n\n## ${label} lockfile changes\n${patch}`);
      lockFiles.push(saved);
      return `## Lockfile changes\nLockfile paths are included in the statistics above. Their patch is separate: ${JSON.stringify(saved.file)} (reference ${saved.digest}). These changes remain in review scope: read this patch when assessing dependency or integrity changes. Security reviewers and Verifiers must inspect relevant lockfile changes before clearing their claims.`;
    };
    const parts = [header, rules];
    if (change) parts.push(`## Complete change\nComparison: git diff ${full}\n${change.stat}\n${change.patch || "No non-lockfile changes."}`, await lockMaterial(change.locks, "full"));
    if (work.portReview) {
      const port = work.portReview;
      // Git rejects range-diff when either side has no commits. Explicit before/after
      // patches still show a removed or newly introduced change without inventing a port.
      const compare = async (paths: string[], includeEmpty = false) => {
        if (port.from !== port.head && port.onto !== head) return output(path, ["range-diff", "--no-color", `${port.from}..${port.head}`, `${port.onto}..${head}`, "--", ...paths]);
        const patch = (range: string) => output(path, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", range, "--", ...paths]);
        const [before, after] = await Promise.all([port.from === port.head ? "" : patch(`${port.from}..${port.head}`), port.onto === head ? "" : patch(`${port.onto}..${head}`)]);
        return before || after || includeEmpty ? `Previous reviewed change:\n${before || (port.from === port.head ? "No commits in this range." : "No changes.")}\n\nCurrent port:\n${after || (port.onto === head ? "No commits in this range." : "No changes.")}` : "";
      };
      const [ported, portLocks, resolved] = await Promise.all([compare([".", ...EXCLUDE_LOCKS], true), compare(ONLY_LOCKS), comparison(path, `${port.onto}..${head}`, port.files)]);
      parts.push(`## Port of the previously reviewed change\n${ported}`);
      parts.push(`## Resolved files against the new base\n${resolved.stat}\n${resolved.patch || "No non-lockfile changes."}`, await lockMaterial([portLocks, resolved.locks].filter(Boolean).join("\n\n"), "port"));
    }
    signal.throwIfAborted();
    const saved = await immutable(folder, "full.md", parts.filter(Boolean).join("\n\n"));
    artifacts.push(saved);
    materials.push(`- ${work.source?.product.name ?? work.productId} (${work.productId}), commit ${head}, base ${base}: ${JSON.stringify(saved.file)} (reference ${saved.digest}); ${work.portReview ? "port comparison and resolved files for the previously reviewed change" : `complete comparison git diff ${base}...HEAD`}, with HEAD fixed at ${head}`);
    if (fixes && delta) {
      const incremental = await immutable(folder, "incremental.md", [header, rules, `## Changes since the last completed code-review round\nComparison: git diff ${delta}\n${fixes.stat}\n${fixes.patch || "No non-lockfile changes."}`, await lockMaterial(fixes.locks, "incremental")].filter(Boolean).join("\n\n"));
      artifacts.push(incremental);
      materials.push(`  Incremental comparison git diff ${work.reviewedSha}..HEAD: ${JSON.stringify(incremental.file)} (reference ${incremental.digest}). Code reviewers on this fix round read this file; the full file is available when earlier context is needed.`);
    }
    artifacts.push(...lockFiles);
  }
  input.material = { title: PREPARED_REVIEW, body: `Petrina prepared the saved base's REVIEW.md and exact comparisons once for this round. Read the files appropriate to your scope; do not regenerate the same diffs or guide just to load context. Code reviewers on a fix round read the separate incremental file. When your saved base advanced, also follow the base-update section: read the complete comparison against the new base and revisit incoming changes and their interactions. Otherwise the complete change need not be reread. Security reviewers and Verifiers retain their full-change scope and use the full file. Lockfile patches are separate, linked from each comparison, never excluded from review scope. Port reviews use the full file's port comparison. Inspect the full code and run focused reproductions wherever needed. The engine's passing checks remain the automated evidence.\n${materials.join("\n")}` };
  input.artifacts = artifacts;
  await freezeReviewHistory(folder, input);
  signal.throwIfAborted();
  const saved = await immutable(folder, "json", JSON.stringify(input));
  return { ...saved, heads, trees };
}

export async function readReviewInput(ref: InputRef): Promise<ReviewInput> {
  const body = await readFile(ref.file, "utf8");
  if (digest(body) !== ref.digest) throw new Error("The saved review inputs changed. Try the review again.");
  const input = JSON.parse(body) as ReviewInput;
  if (input.history) await readReviewHistory(input.history);
  await Promise.all((input.artifacts ?? []).map(async (artifact) => {
    if (digest(await readFile(artifact.file, "utf8")) !== artifact.digest) throw new Error("The prepared review comparison changed. Start this review again.");
  }));
  return input;
}

/** A missing full packet invalidates reduction; open a complete fresh review instead. */
export async function reviewContextIntact(context: BuilderContext | undefined): Promise<boolean> {
  return !!context && await readFile(context.file, "utf8").then((body) => digest(body) === context.digest, () => false);
}

export function reviewScopeKey(scope: RepositoryContext, stageId: Id, seat: Id, role: Role, planned: unknown, actual: unknown): string {
  return reviewConversationScope(repositoryView(scope), stageId, seat, role, planned, actual);
}

export function reviewBases(scope: RepositoryContext): Record<Id, string> {
  return Object.fromEntries(scopesFor(scope.task).flatMap(({ work }) => work.baseSha ? [[work.productId, work.baseSha]] : []));
}

/** Forward execution bases are compatible, independently of the immutable approved source identity. */
export async function reviewBaseUpdates(scope: RepositoryContext, bases: Readonly<Record<Id, string>> | undefined, heads: Readonly<Record<Id, string>>): Promise<{ sections: Section[]; reason?: string }> {
  const scopes = scopesFor(scope.task);
  if (!bases || Object.keys(bases).length !== scopes.length) return { sections: [], reason: "its saved repository bases are unavailable" };
  const updates: string[] = [];
  for (const { work } of scopes) {
    const before = bases[work.productId], base = work.baseSha, head = heads[work.productId];
    if (!before || !base || !head || !work.worktree) return { sections: [], reason: "its saved repository bases are unavailable" };
    if (work.portReview || work.updating) return { sections: [], reason: "the change requires a conflict port review" };
    if (before === base) continue;
    if (!(await git.contains(work.worktree, base, before))) return { sections: [], reason: "its starting branch's history was replaced or diverged" };
    const [incoming, changed, count] = await Promise.all([
      git.changedFiles(work.worktree, before, base),
      git.changedFiles(work.worktree, base, head),
      output(work.worktree, ["rev-list", "--count", `${before}..${base}`]),
    ]);
    const overlap = incoming.filter((file) => changed.includes(file));
    const commits = Number(count.trim());
    if (!Number.isSafeInteger(commits) || commits < 1) throw new Error("Could not count the starting branch's incoming commits for review.");
    const branch = work.source?.start.branch ?? "main", source = branch === "main" ? "Main" : branch;
    const incremental = work.reviewedSha
      ? `Read the incremental comparison too. ${source}'s incoming changes are not in the incremental comparison: it contains only this task's changes since the last round, carried onto the new base.`
      : "No incremental comparison is available. Review the complete change.";
    updates.push(`### ${work.source?.product.name ?? work.productId} (${work.productId})\nOld base: ${before}\nNew base: ${base}\n${source} gained ${commits} commit${commits === 1 ? "" : "s"}.\nExact commit under review: ${head}\nThe change was carried onto the new base without an engine conflict port.\nFiles the starting branch changed that this task also changes; read their current versions again:\n${overlap.map((file) => `- ${JSON.stringify(file)}`).join("\n") || "None."}\nRead the complete prepared comparison against ${base} and its current base review guide. ${incremental} Inspect the incoming range ${before}..${base} and its interactions wherever relevant, including beyond the files listed above. Review all code that now requires review, not only the Builder's fixes.`);
  }
  return { sections: updates.length ? [{ title: "The review base advanced since your last review", body: updates.join("\n\n") }] : [] };
}

/** Retain the established native SHA256 scope while the portable owner projects its exact fields. */
export function reviewConversationScope(task: Task, stageId: Id, seat: Id, role: Role, planned: unknown, actual: unknown): string {
  return projectReviewScope(task, stageId, seat, role, planned, actual, digest);
}
