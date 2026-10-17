// What agents learned about working in a product's repository, kept where every agent already looks: the
// "Learnings" section of the repository's AGENTS.md, which Claude Code and Codex both load by themselves, in
// a session Petrina starts or one the coordinator starts by hand. Petrina adds nothing to their prompts.
// Agents pass lessons on with their results, the coordinator accepts or declines them at the delivery check,
// and accepted ones reach AGENTS.md with a delivery.

import type { DeepMutable, GuideLine, Id } from "@petrina/core";
import * as git from "./git.js";
import { addToSection, AGENTS_FILE, cleanPoint, hasPoint, localPoints, samePointRoughly } from "./points.js";
import type { Kernel, MTask } from "./kernel.js";

const SECTION = "## Learnings";
const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";

/** The most lessons one task offers: the bar is high, so a few is plenty. */
const MAX_LESSONS = 8;

export class Learnings {
  constructor(private readonly k: Kernel) {}

  /** An agent's lessons, kept on the task until the delivery check. Repeats, and ones AGENTS.md already has, are left out. */
  note(task: MTask, lessons: readonly string[], roleId: Id, profileId: Id): void {
    const known = this.known(task);
    for (const raw of lessons) {
      // The coordinator approves this instruction as written; cutting it can lose a path or a qualification.
      const text = cleanPoint(raw);
      // Agents often say the same thing in other words: the first saying of a point is the one offered.
      if (text.length < 8 || hasPoint(known, text) || known.split("\n").some((line) => samePointRoughly(line, text)) || (task.lessons ?? []).some((lesson) => hasPoint(lesson.text, text) || samePointRoughly(lesson.text, text))) continue;
      if ((task.lessons?.length ?? 0) >= MAX_LESSONS) break;
      task.lessons = [...(task.lessons ?? []), { text, roleId, profileId, at: Date.now() }];
    }
  }

  /**
   * What AGENTS.md says, what was accepted, and what the coordinator said no to: none of it is offered again. The
   * file is read as the task's branch has it (what would land, main's latest lines included once the work is
   * brought up to date), or at the task's base before there is a branch.
   */
  private known(task: MTask): string {
    const product = this.k.productOf(task);
    const file = (task.worktree && git.fileAt(task.worktree, "HEAD", AGENTS_FILE)) || this.baseFile(task);
    return [file, ...(product?.learnings ?? []).map((line) => line.text), ...(product?.learningsDeclined ?? [])].join("\n");
  }

  /** Lessons that AGENTS.md, or the coordinator's answers, have covered since they were noted. */
  private covered(task: MTask, text: string): boolean {
    const known = this.known(task);
    return hasPoint(known, text) || known.split("\n").some((line) => samePointRoughly(line, text));
  }

  /**
   * At the delivery check: the task's lessons offered to the coordinator in one inbox item, without holding anything
   * up. A lesson AGENTS.md gained in the meantime (from another task, or the coordinator's own hand) is not offered.
   */
  offer(task: MTask): void {
    const product = this.k.productOf(task);
    const lessons = (task.lessons ?? []).filter((lesson) => !this.covered(task, lesson.text));
    delete task.lessons;
    if (!product || !lessons.length) return;
    const from = [...new Set(lessons.map((lesson) => this.k.role(lesson.roleId)?.name ?? lesson.roleId))];
    const state = task.state;
    this.k.raise(
      task,
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
    this.k.log(task, "done", `Agents passed on ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} about working in this repository: offered to you`);
  }

  /** "Add them": the lessons wait for the next delivery, which writes them into AGENTS.md. */
  accept(itemId: Id, keep?: readonly number[]): void {
    const item = this.k.s.inbox.find((entry) => entry.id === itemId && entry.kind === "learnings");
    if (!item) return;
    this.k.takeItem(itemId);
    const task = this.k.task(item.taskId);
    const product = task && this.k.productOf(task);
    if (!task || !product) return;
    // The ones the coordinator ticked, by their place in the offer; all of them when it says nothing.
    const offered = (item.body ?? "")
      .split("\n")
      .map((line) => cleanPoint(line.replace(/^- /, "")))
      .filter(Boolean);
    const lessons = offered.filter((_, index) => !keep || keep.includes(index));
    this.remember(product, offered.filter((text) => !lessons.includes(text)));
    const added = lessons.filter((text) => !product.learnings?.some((line) => hasPoint(line.text, text)));
    product.learnings = [...(product.learnings ?? []), ...added.map((text) => ({ text, at: Date.now(), fromTask: task.id }))];
    this.k.log(task, "you", `You added ${added.length === 1 ? "a lesson" : `${added.length} lessons`} to ${AGENTS_FILE}`);
    this.k.commit();
  }

  /** "Not this time": AGENTS.md stays as it is. */
  decline(itemId: Id): void {
    const item = this.k.s.inbox.find((entry) => entry.id === itemId && entry.kind === "learnings");
    if (!item) return;
    this.k.takeItem(itemId);
    const task = this.k.task(item.taskId);
    const product = task && this.k.productOf(task);
    if (product) this.remember(product, (item.body ?? "").split("\n").map((line) => cleanPoint(line.replace(/^- /, ""))).filter(Boolean));
    if (task) this.k.log(task, "you", `You left ${AGENTS_FILE} as it is`);
    this.k.commit();
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
  async write(task: MTask): Promise<void> {
    const product = this.k.productOf(task);
    if (!product?.learnings?.length || !task.worktree) return;
    const free = (line: { writtenOn?: Id }) => !line.writtenOn || line.writtenOn === task.id || ["cancelled", "failed"].includes(this.k.task(line.writtenOn)?.state ?? "cancelled");
    let due: DeepMutable<GuideLine>[];
    try {
      const file = localPoints(task.worktree, AGENTS_FILE);
      due = product.learnings.filter((line) => !hasPoint(file, line.text) && free(line));
      if (!due.length) return;
      addLearnings(task.worktree, due.map((line) => line.text));
    } catch (error) {
      this.k.log(task, "warn", `${AGENTS_FILE} was not updated: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await git.commitAll(task.worktree, `Learnings: ${due.length === 1 ? "one more lesson" : `${due.length} more lessons`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina with the coordinator's OK.`);
    for (const line of due) line.writtenOn = task.id;
    this.k.log(task, "done", `Added to ${AGENTS_FILE}: ${due.map((line) => line.text).join("; ")}`);
    this.k.commit();
  }

  /** AGENTS.md as the base branch has it. */
  private baseFile(task: MTask): string {
    const product = this.k.productOf(task);
    const ref = task.baseSha ?? task.base;
    const root = product?.path ?? task.worktree;
    return ref && root ? (git.fileAt(root, ref, AGENTS_FILE) ?? "") : "";
  }
}

/** Lessons added at the end of AGENTS.md's Learnings section, starting the section (or the file) when there is none. */
export function addLearnings(root: string, lessons: readonly string[]): void {
  addToSection(root, SECTION, INTRO, lessons.map((lesson) => `- ${cleanPoint(lesson)}`));
}
