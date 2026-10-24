import { type RepositoryContext } from "@petrina/orchestrator";
// What agents learned about working in a product's repository, kept where every agent already looks: the
// "Learnings" section of the repository's AGENTS.md, which Claude Code and Codex both load by themselves, in
// a session Petrina starts or one the coordinator starts by hand. Petrina adds nothing to their prompts.
// Agents pass lessons on with their results, the coordinator accepts or declines them at the delivery check,
// and accepted ones reach AGENTS.md with a delivery.

import type { DeepMutable, GuideLine, Id, Product } from "@petrina/core";
import * as git from "./git.js";
import { addToSection, AGENTS_FILE, cleanPoint, hasPoint, localPoints, sectionEnd, withSection } from "./points.js";
import type { Kernel } from "./kernel.js";

const SECTION = "## Learnings";
const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";

/** The most lessons one task offers: the bar is high, so a few is plenty. */
const MAX_LESSONS = 8;

export function offeredLessons(body: string | undefined): string[] {
  return (body ?? "").split("\n").map(line => cleanPoint(line.replace(/^- /, ""))).filter(Boolean);
}

export class Learnings {
  constructor(private readonly k: Kernel) {}

  /** An agent's lessons, kept on the task until the delivery check. Repeats, and ones AGENTS.md already has, are left out. */
  async note(scope: RepositoryContext, lessons: readonly (string | { productId: string; text: string })[], roleId: Id, profileId: Id): Promise<void> {
    const { task, work: repository } = scope;
    if (!lessons.length) return;
    const own: string[] = [];
    const companions = new Map<Id, { work: RepositoryContext["work"]; texts: string[] }>();
    for (const lesson of lessons) {
      const text = typeof lesson === "string" ? lesson : lesson.text;
      const id = typeof lesson === "string" ? this.k.role(roleId)?.canEdit ? repository.productId : undefined : lesson.productId;
      if (!task.repositories || id === repository.productId) { own.push(text); continue; }
      const work = id ? task.repositories.find((entry) => entry.productId === id) : undefined;
      if (work) {
        const group = companions.get(work.productId) ?? { work, texts: [] };
        group.texts.push(text);
        companions.set(work.productId, group);
      } else if (!task.sharedLessons?.some((entry) => entry.text === text)) task.sharedLessons = [...(task.sharedLessons ?? []), { text, roleId, profileId, at: Date.now() }];
    }
    for (const { work, texts } of companions.values()) await this.note({ task, work }, texts.map((text) => ({ productId: work.productId, text })), roleId, profileId);
    if (!own.length) return;
    const known = await this.known(scope);
    for (const raw of own) {
      // The coordinator approves this instruction as written; cutting it can lose a path or a qualification.
      const text = cleanPoint(raw);
      // Changed wording may correct an old instruction. Only repeated text is already covered.
      if (text.length < 8 || hasPoint(known, text) || (repository.lessons ?? []).some((lesson) => hasPoint(lesson.text, text))) continue;
      if ((repository.lessons?.length ?? 0) >= MAX_LESSONS) break;
      repository.lessons = [...(repository.lessons ?? []), { text, roleId, profileId, at: Date.now() }];
    }
  }

  /**
   * What AGENTS.md says, what was accepted, and what the coordinator said no to: none of it is offered again. The
   * file is read as the task's branch has it (what would land, main's latest lines included once the work is
   * brought up to date), or at the task's base before there is a branch.
   */
  private async known(scope: RepositoryContext): Promise<string> {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    const file = repository.worktree ? await git.fileAt(repository.worktree, "HEAD", AGENTS_FILE) : await this.baseFile(scope);
    return [file, ...(product?.learnings ?? []).map((line) => line.text), ...(product?.learningsDeclined ?? [])].join("\n");
  }

  /** Lessons that AGENTS.md, or the coordinator's answers, have covered since they were noted. */
  private covered(known: string, text: string): boolean {
    return hasPoint(known, text);
  }

  /**
   * At the delivery check: the task's lessons offered to the coordinator in one inbox item, without holding anything
   * up. A lesson AGENTS.md gained in the meantime (from another task, or the coordinator's own hand) is not offered.
   */
  async offer(scope: RepositoryContext): Promise<void> {
    const { task, work: repository } = scope;
    const product = this.k.productOf(scope);
    if (!product || !repository.lessons?.length) {
      delete repository.lessons;
      return;
    }
    const known = await this.known(scope);
    const lessons = repository.lessons.filter((lesson) => !this.covered(known, lesson.text));
    delete repository.lessons;
    if (!product || !lessons.length) return;
    const from = [...new Set(lessons.map((lesson) => this.k.role(lesson.roleId)?.name ?? lesson.roleId))];
    const state = task.state;
    this.k.raise(
      scope,
      "learnings",
      `What agents learned about ${product.name}`,
      false,
      {
        body: lessons.map((lesson) => `- ${lesson.text}`).join("\n"),
        detail: `From the ${from.join(" and the ")}. What you add joins the Learnings section of ${AGENTS_FILE} with the next delivery. Claude Code and Codex both read that file by themselves, whether Petrina starts them or you do.`,
      },
      { roleId: lessons[0]!.roleId, profileId: lessons[0]!.profileId },
    );
    task.state = state;
    this.k.log(scope, "done", `Agents passed on ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} about working in this repository: offered to you`);
  }

  /** "Add them": the lessons wait for the next delivery, which writes them into AGENTS.md. */
  accept(itemId: Id, keep?: readonly number[]): void {
    const item = this.k.s.inbox.find((entry) => entry.id === itemId && entry.kind === "learnings");
    if (!item) return;
    this.k.takeItem(itemId);
    const task = this.k.task(item.taskId);
    const product = task && (item.productId ? this.k.s.products.find((entry) => entry.id === item.productId) : this.k.productOf(task));
    if (!task || !product) return;
    // The ones the coordinator ticked, by their place in the offer; all of them when it says nothing.
    const offered = offeredLessons(item.body);
    const lessons = offered.filter((_, index) => !keep || keep.includes(index));
    this.remember(product, offered.filter((text) => !lessons.includes(text)));
    const added = lessons.filter((text) => !product.learnings?.some((line) => hasPoint(line.text, text)));
    product.learnings = [...(product.learnings ?? []), ...added.map((text) => ({ text, at: Date.now(), fromTask: task.id }))];
    this.k.log(task, "you", `You added ${added.length === 1 ? "a lesson" : `${added.length} lessons`} to ${AGENTS_FILE}`);
    this.k.commit(task);
  }

  /** "Not this time": AGENTS.md stays as it is. */
  decline(itemId: Id): void {
    const item = this.k.s.inbox.find((entry) => entry.id === itemId && entry.kind === "learnings");
    if (!item) return;
    this.k.takeItem(itemId);
    const task = this.k.task(item.taskId);
    const product = task && (item.productId ? this.k.s.products.find((entry) => entry.id === item.productId) : this.k.productOf(task));
    if (product) this.remember(product, (item.body ?? "").split("\n").map((line) => cleanPoint(line.replace(/^- /, ""))).filter(Boolean));
    if (task) this.k.log(task, "you", `You left ${AGENTS_FILE} as it is`);
    this.k.commit(task);
  }

  /** Lessons the coordinator said no to, so agents' later sayings of them are not offered again. */
  private remember(product: NonNullable<ReturnType<Kernel["productOf"]>>, declined: readonly string[]): void {
    if (!declined.length) return;
    product.learningsDeclined = [...(product.learningsDeclined ?? []), ...declined].slice(-100);
  }

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
    await git.commitAll(repository.worktree, `Learnings: ${due.length === 1 ? "one more lesson" : `${due.length} more lessons`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina with the coordinator's OK.`);
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

/** AGENTS.md's text as `addLearnings` leaves it. */
export function withLearnings(text: string, lessons: readonly string[]): string {
  return withSection(text, SECTION, INTRO, lessons.map((lesson) => `- ${cleanPoint(lesson)}`));
}

/**
 * The exact lessons Petrina's writer added at the end of `base`'s Learnings section to make `file`, in order:
 * writing them again gives `file` byte for byte. Undefined when `file` is anything else, or `base` has no
 * Learnings section yet.
 */
export function addedLessons(base: string, file: string): string[] | undefined {
  const at = sectionEnd(base, SECTION);
  if (!at || !file.endsWith("\n")) return undefined;
  const lines = file.slice(0, -1).split("\n");
  const middle = lines.slice(at.before.length, lines.length - at.after.length);
  if (lines.length < at.before.length + at.after.length || !middle.every((line) => line.startsWith("- "))) return undefined;
  const lessons = middle.map((line) => line.slice(2));
  return withLearnings(base, lessons) === file ? lessons : undefined;
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
  if (!product || merged.conflicts.length !== 1 || merged.conflicts[0] !== AGENTS_FILE) return undefined;
  try {
    const [base, main, own] = await Promise.all([fork, onto, ref].map((version) => git.plainFileAt(worktree, version, AGENTS_FILE)));
    if (!base || !main || !own || main.mode !== base.mode || own.mode !== base.mode) return undefined;
    // A version that does not read back as it is (not UTF-8) could not be kept exactly.
    if ([base, main, own].some((file) => file.text.includes("\uFFFD"))) return undefined;
    const theirs = addedLessons(base.text, main.text), ours = addedLessons(base.text, own.text);
    if (!theirs?.length || !ours?.length) return undefined;
    // The starting point and main's history as the commits record them, whatever Git's commit index says.
    if ((await git.mergeBase(worktree, ref, onto, true)) !== fork) return undefined;
    const versions = await git.versionsBetween(worktree, fork, onto, AGENTS_FILE);
    // Read in one go after Git answers: the tidy-up turns a waiting lesson into a receipt in one step.
    const receipts = [...(product.learningReceipts ?? [])];
    const records = [...(product.learnings ?? []), ...receipts];
    const wrote = (text: string, here: boolean) => records.some((line) => line.text === text && line.writtenOn !== undefined && (line.writtenOn === taskId) === here);
    if (!theirs.every((text) => wrote(text, false)) || !ours.every((text) => wrote(text, true))) return undefined;
    const added: string[] = [];
    const present: string[] = [];
    for (const [index, text] of ours.entries()) {
      if (hasPoint(base.text, text) || ours.some((other, at) => at !== index && hasPoint(other, text))) return undefined;
      const same = theirs.filter((line) => hasPoint(line, text));
      if (same.some((line) => line !== text)) return undefined;
      if (same.length) present.push(text);
      // Nothing main removed comes back: a version of the file since the starting point had it.
      else if (versions.some((version) => hasPoint(version, text))) return undefined;
      else added.push(text);
    }
    // Or a receipt says main took it in, at a version latest main includes.
    const taken = new Set(receipts.filter((receipt) => added.some((text) => hasPoint(receipt.text, text))).map((receipt) => receipt.foundOn));
    for (const sha of taken) if (await git.contains(worktree, onto, sha, true)) return undefined;
    const text = withLearnings(main.text, added);
    if (text !== withLearnings(base.text, [...theirs, ...added])) return undefined;
    return { tree: await git.withRootFile(worktree, merged.tree, AGENTS_FILE, main.mode, text), added, present };
  } catch {
    return undefined;
  }
}
