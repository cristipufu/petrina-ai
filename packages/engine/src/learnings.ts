import { keepApprovedLearnings, LearningOffers, type RepositoryContext } from "@petrina/orchestrator";
// What agents learned about working in a product's repository, kept where every agent already looks: the
// "Learnings" section of the repository's AGENTS.md, which Claude Code and Codex both load by themselves, in
// a session Petrina starts or one the coordinator starts by hand. Petrina adds nothing to their prompts.
// Agents pass lessons on with their results, the coordinator accepts or declines them at the delivery check,
// and accepted ones reach AGENTS.md with a delivery.

import { AGENTS_FILE, cleanPoint, hasPoint, LEARNINGS_INTRO as INTRO, LEARNINGS_SECTION as SECTION, type DeepMutable, type GuideLine, type Id, type Product } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { plainFilesAt } from "@petrina/repositories/object-batch";
import { addToSection, localPoints } from "./points.js";
import type { Kernel } from "./kernel.js";

export class Learnings {
  private readonly offers: LearningOffers;
  constructor(private readonly k: Kernel) {
    this.offers = new LearningOffers({
      current: () => k.s, task: id => k.task(id), productOf: target => k.productOf(target), role: id => k.role(id),
      authoritativeFile: scope => scope.work.worktree ? git.fileAt(scope.work.worktree, "HEAD", AGENTS_FILE) : this.baseFile(scope),
      offer: (scope, title, details, by) => { k.raise(scope, "learnings", title, false, details, by); },
      removeOffer: id => { k.takeItem(id); }, log: (target, kind, text) => k.log(target, kind, text),
      checkpoint: task => k.commit(task), now: () => Date.now(),
    });
  }

  note(scope: RepositoryContext, lessons: readonly (string | { productId: string; text: string })[], roleId: Id, profileId: Id): Promise<void> {
    return this.offers.note(scope, lessons, roleId, profileId);
  }
  offer(scope: RepositoryContext): Promise<void> { return this.offers.offer(scope); }
  accept(itemId: Id, keep?: readonly number[]): void { this.offers.accept(itemId, keep); }
  decline(itemId: Id): void { this.offers.decline(itemId); }

  /**
   * Accepted lessons reach AGENTS.md's Learnings section on a branch that ships: the task they came from, or
   * else the next one to reach its delivery check. Nothing is running in the working copy at this point.
   */
  async write(scope: RepositoryContext): Promise<void> {
    const { task, work: repository } = scope;
    const product = this.k.productOf(scope);
    if (!product?.learnings?.length || !repository.worktree) return;
    const free = (line: { writtenOn?: Id }) => !line.writtenOn || line.writtenOn === task.id || ["cancelled", "failed"].includes(this.k.task(line.writtenOn)?.state ?? "cancelled");
    let due: DeepMutable<GuideLine>[];
    try {
      const file = localPoints(repository.worktree, AGENTS_FILE);
      due = product.learnings.filter((line) => !hasPoint(file, line.text) && free(line));
      if (!due.length) return;
      addLearnings(repository.worktree, due.map((line) => line.text));
    } catch (error) {
      this.k.log(scope, "warn", `${AGENTS_FILE} was not updated: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await git.commitChanges(repository.worktree, `Learnings: ${due.length === 1 ? "one more lesson" : `${due.length} more lessons`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina with the coordinator's OK.`);
    await this.k.rememberVersion(scope);
    for (const line of due) line.writtenOn = task.id;
    this.k.log(scope, "done", `Added to ${AGENTS_FILE}: ${due.map((line) => line.text).join("; ")}`);
    this.k.commit();
  }

  /** AGENTS.md as the base branch has it. */
  private async baseFile(scope: RepositoryContext): Promise<string> {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    const ref = repository.baseSha ?? repository.base;
    const root = product?.path ?? repository.worktree;
    return ref && root ? ((await git.fileAt(root, ref, AGENTS_FILE)) ?? "") : "";
  }
}

/** Lessons added at the end of AGENTS.md's Learnings section, starting the section (or the file) when there is none. */
export function addLearnings(root: string, lessons: readonly string[]): void {
  addToSection(root, SECTION, INTRO, lessons.map((lesson) => `- ${cleanPoint(lesson)}`));
}

/** An update's AGENTS.md when both sides only added approved lessons, in the merge's otherwise clean tree. */
export interface KeptLearnings {
  tree: string;
  /** The task's lessons, added after main's. */
  added: string[];
  /** The task's lessons main already has word for word, kept once. */
  present: string[];
}

/**
 * A task brought onto main, where AGENTS.md is the only conflict and both sides did nothing to it but add lessons
 * the coordinator accepted, at the end of a Learnings section the shared starting version already had. Each side's
 * whole file is exactly what Petrina's writer makes from the starting version and its lessons; each of the task's
 * lessons, by its exact text in the waiting list or a receipt, one Petrina wrote for this task, and each of
 * main's one it wrote for another. The same lesson is only what `hasPoint` already says it is. Kept: main's file,
 * with the task's lessons it lacks added by the same writer. Undefined (the builder brings the work up to date)
 * for anything else or unproven, including a lesson main had since the starting point, or took in, and removed,
 * and any part of that history Git cannot read. `ref`: the task's version merged onto `onto`.
 */
export async function keptLearnings(product: Pick<Product, "learnings" | "learningReceipts"> | undefined, taskId: Id, worktree: string, fork: string, onto: string, merged: { tree: string; conflicts: readonly string[] }, ref = "HEAD"): Promise<KeptLearnings | undefined> {
  const versions = [fork, onto, ref];
  let instructions: ReturnType<typeof plainFilesAt> | undefined;
  return keepApprovedLearnings(product ? { current: () => product } : undefined, { taskId, fork, onto, merged, ref }, {
    instructionsAt: version => {
      const index = versions.indexOf(version);
      return index < 0 ? git.plainFileAt(worktree, version, AGENTS_FILE)
        : (instructions ??= plainFilesAt(worktree, versions, AGENTS_FILE)).then(files => files[index]);
    },
    objectMergeBase: (own, main) => git.mergeBase(worktree, own, main, true),
    instructionVersionsBetween: (start, main) => git.versionsBetween(worktree, start, main, AGENTS_FILE),
    objectHistoryContains: (main, sha) => git.contains(worktree, main, sha, true),
    instructionsInTree: (tree, mode, text) => git.withRootFile(worktree, tree, AGENTS_FILE, mode, text),
  });
}
