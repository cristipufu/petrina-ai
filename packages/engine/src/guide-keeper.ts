// The review guide that learns from misses: the Guide keeper's proposals, the coordinator's yes or no,
// and accepted points reaching REVIEW.md. Reading and writing the file is in points.ts.

import { type DeepMutable, type Id, type GuideLine, type Task } from "@petrina/core";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { GuideResult } from "./roles.js";
import { addToSection, AGENTS_FILE, appendPoints, cleanPoint, GUIDE, GUIDE_FILE, hasPoint, localPoints, pointsText } from "./points.js";

/** What AGENTS.md says about the review guide, so every agent reads it, in Petrina or not. */
const GUIDE_SECTION = "## Review guide";
const GUIDE_POINTER = `Every change here is reviewed against ${GUIDE_FILE}: read it before you build or review one. A change is judged by the guide as the default branch has it, never by what the change itself writes there.`;
import { Kernel, Aborted, GUIDE_KEEPER_PROFILE, type MTask } from "./kernel.js";
import type { Turns } from "./turn.js";

export class GuideKeeper {
  constructor(private readonly k: Kernel, private readonly turns: Turns) {}

  /** "Add it": the proposed point joins the product's review guide. Reviewers see it from their next turn. */
  acceptGuideLine(itemId: Id): void {
    const item = this.k.takeItem(itemId);
    const task = item && this.k.task(item.taskId);
    const product = task && this.k.productOf(task);
    const point = cleanPoint(item?.body ?? "");
    if (!point || !task || !product) return;
    if (!product.reviewGuide?.some((line) => line.text === point)) product.reviewGuide = [...(product.reviewGuide ?? []), { text: point, at: Date.now(), fromTask: task.id }];
    this.k.log(task, "you", `You added to the review guide: ${point}`);
    this.k.commit();
  }

  /** "Not this time": the review guide stays as it is. */
  declineGuide(itemId: Id): void {
    const item = this.k.s.inbox.find((entry) => entry.id === itemId && entry.kind === "guide");
    if (!item) return;
    this.k.takeItem(itemId);
    const task = this.k.task(item.taskId);
    if (task) this.k.log(task, "you", "You left the review guide as it is");
    this.k.commit();
  }

  /**
   * The coordinator sent back a delivery every reviewer passed: the Guide keeper proposes one point for
   * the product's review guide, offered in the inbox without holding the task up. A side errand inside
   * the builder's step: it leaves the step's own restart bookkeeping as it found it.
   */
  async proposeGuideLine(task: MTask, signal: AbortSignal): Promise<void> {
    const product = this.k.productOf(task);
    const miss = task.miss;
    if (!product || !miss || !task.worktree) return;
    const attempts = task.stepAttempts;
    const conversation = task.conversation;
    const restore = () => {
      if (attempts === undefined) delete task.stepAttempts;
      else task.stepAttempts = attempts;
      if (conversation === undefined) delete task.conversation;
      else task.conversation = conversation;
    };
    try {
      const guide = this.reviewGuide(task);
      const result = await this.turns.turn(
        task,
        "guide-keeper",
        GUIDE_KEEPER_PROFILE,
        () => [
          { title: "The coordinator's note when sending the delivery back", body: miss.note },
          { title: `The review guide now (${GUIDE_FILE})`, body: guide || "There is none yet." },
          ...(task.findings.length ? [{ title: "What the reviewers did raise", body: formatFindings(task.findings as Task["findings"]) }] : []),
        ],
        GuideResult,
        signal,
        { status: "Looking for what the reviewers missed" },
      );
      restore();
      if (!result.missed || !result.line) this.k.log(task, "done", `Nothing for the review guide: ${result.why}`, "guide-keeper", GUIDE_KEEPER_PROFILE);
      else if (hasPoint(guide, result.line)) this.k.log(task, "done", "The review guide already has that point", "guide-keeper", GUIDE_KEEPER_PROFILE);
      else {
        // An offer, not a stop: the task carries on while the coordinator decides.
        const state = task.state;
        this.k.raise(task, "guide", `Add a point to ${product.name}'s review guide?`, false, { body: result.line, detail: `${result.why} It goes into ${GUIDE_FILE}, which AGENTS.md points every agent to, in Petrina or in your own sessions.` });
        task.state = state;
        this.k.log(task, "done", `Proposed a point for the review guide: ${result.line}`, "guide-keeper", GUIDE_KEEPER_PROFILE);
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) throw error;
      restore();
      this.k.log(task, "warn", "The Guide keeper could not finish, so nothing was proposed for the review guide");
    }
    delete task.miss;
    this.k.commit();
  }

  /**
   * Accepted points reach REVIEW.md on a branch that ships: the task they came from, or else the next one to
   * reach its delivery check. AGENTS.md gets a short section pointing to the guide when it has none. Nothing is
   * running in the working copy at this point.
   */
  async writeGuide(task: MTask): Promise<void> {
    const product = this.k.productOf(task);
    if (!product?.reviewGuide?.length || !task.worktree) return;
    const free = (line: { writtenOn?: Id }) => !line.writtenOn || line.writtenOn === task.id || ["cancelled", "failed"].includes(this.k.task(line.writtenOn)?.state ?? "cancelled");
    let due: DeepMutable<GuideLine>[];
    try {
      const file = localPoints(task.worktree, GUIDE_FILE);
      due = product.reviewGuide.filter((line) => !hasPoint(file, line.text) && free(line));
      if (!due.length) return;
      appendPoints(task.worktree, GUIDE, due.map((line) => line.text));
      if (!localPoints(task.worktree, AGENTS_FILE).includes(GUIDE_FILE)) addToSection(task.worktree, GUIDE_SECTION, GUIDE_POINTER, []);
    } catch (error) {
      this.k.log(task, "warn", `The review guide was not updated: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await git.commitAll(task.worktree, `Review guide: ${due.length === 1 ? "one more point" : `${due.length} more points`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina: the coordinator accepted ${due.length === 1 ? "it" : "them"} after reviewers missed something.`);
    for (const line of due) line.writtenOn = task.id;
    this.k.log(task, "done", `Added to ${GUIDE_FILE}: ${due.map((line) => line.text).join("; ")}`);
    this.k.commit();
  }

  /** Points the coordinator accepted that the base branch's REVIEW.md does not have yet: reviewers get them with the task. */
  pendingPoints(task: MTask): string[] {
    const product = this.k.productOf(task);
    const ref = task.baseSha ?? task.base;
    const base = ref && (product?.path ?? task.worktree) ? (git.fileAt((product?.path ?? task.worktree)!, ref, GUIDE_FILE) ?? "") : "";
    return (product?.reviewGuide ?? []).filter((line) => !hasPoint(base, line.text)).map((line) => line.text);
  }

  /** The guide as the base branch has it, plus the points the coordinator accepted: what the Guide keeper weighs a new point against. */
  reviewGuide(task: MTask): string {
    const product = this.k.productOf(task);
    const ref = task.baseSha ?? task.base;
    const base = ref && (product?.path ?? task.worktree) ? (git.fileAt((product?.path ?? task.worktree)!, ref, GUIDE_FILE) ?? "") : "";
    return pointsText(GUIDE, base, product?.reviewGuide ?? []);
  }
}
