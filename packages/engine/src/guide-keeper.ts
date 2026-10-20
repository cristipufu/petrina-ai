import { type RepositoryContext } from "./repository-context.js";
// The review guide that learns from misses: the Guide keeper's proposals, the coordinator's yes or no,
// and accepted points reaching REVIEW.md. Reading and writing the file is in points.ts.

import { endAgentStep, JOURNEY_WORDS as W, type DeepMutable, type Id, type GuideLine, type Task } from "@petrina/core";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { GuideResult } from "./roles.js";
import { addToSection, AGENTS_FILE, appendPoints, cleanPoint, GUIDE, GUIDE_FILE, hasPoint, localPoints, pointsText } from "./points.js";

/** What AGENTS.md says about the review guide, so every agent reads it, in Petrina or not. */
const GUIDE_SECTION = "## Review guide";
const GUIDE_POINTER = `Every change here is reviewed against ${GUIDE_FILE}: read it before you build or review one. A change is judged by the guide as the default branch has it, never by what the change itself writes there.`;
import { Kernel, Aborted, GUIDE_KEEPER_PROFILE, ScreenWait } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import { beginSideStep } from "./side-step.js";
import type { Turns } from "./turn.js";

export class GuideKeeper {
  constructor(private readonly k: Kernel, private readonly turns: Turns) {}

  /** "Add it": the proposed point joins the product's review guide. Reviewers see it from their next turn. */
  acceptGuideLine(itemId: Id): void {
    const item = this.k.takeItem(itemId);
    const task = item && this.k.task(item.taskId);
    const product = task && (item.productId ? this.k.s.products.find((entry) => entry.id === item.productId) : this.k.productOf(task));
    const point = cleanPoint(item?.body ?? "");
    if (!point || !task || !product) return;
    const existing = product.reviewGuide?.find((line) => line.text === point);
    if (existing?.incorporatedOn) {
      // Explicitly accepting a removed rule again is a new instruction, with a new delivery owner.
      existing.at = Date.now();
      existing.fromTask = task.id;
      delete existing.writtenOn;
      delete existing.incorporatedOn;
    } else if (!existing) product.reviewGuide = [...(product.reviewGuide ?? []), { text: point, at: Date.now(), fromTask: task.id }];
    this.k.log(task, "you", `You added to the review guide: ${point}`);
    this.k.commit(task);
  }

  /** "Not this time": the review guide stays as it is. */
  declineGuide(itemId: Id): void {
    const item = this.k.s.inbox.find((entry) => entry.id === itemId && entry.kind === "guide");
    if (!item) return;
    this.k.takeItem(itemId);
    const task = this.k.task(item.taskId);
    if (task) this.k.log(task, "you", "You left the review guide as it is");
    this.k.commit(task);
  }

  /**
   * The coordinator sent back a delivery every reviewer passed: the Guide keeper proposes one point for
   * the product's review guide, offered in the inbox without holding the task up. A side errand inside
   * the builder's step: it leaves the step's own restart bookkeeping as it found it.
   */
  async proposeGuideLine(scope: RepositoryContext, signal: AbortSignal): Promise<void> {
    const { task, work: repository } = scope;
    const product = this.k.productOf(scope);
    const miss = task.miss;
    if (!product || !miss || !repository.worktree) return;
    const restore = beginSideStep(this.k, scope, "guide-keeper");
    // On a tool the squad can use, like every other step.
    const keeper = this.k.onUsable(GUIDE_KEEPER_PROFILE);
    let ran: Id = keeper;
    try {
      const guide = await this.reviewGuide(scope);
      const result = await this.turns.turn(
        scope,
        "guide-keeper",
        keeper,
        () => [
          { title: "The coordinator's note when sending the delivery back", body: miss.note },
          { title: `The review guide now (${GUIDE_FILE})`, body: guide || "There is none yet." },
          ...(task.findings.length ? [{ title: "What the reviewers did raise", body: formatFindings(task.findings as Task["findings"]) }] : []),
        ],
        GuideResult,
        signal,
        { status: "Looking for what the reviewers missed", used: (id) => (ran = id) },
      );
      this.k.releaseScreen(task);
      restore();
      const proposed = !!result.missed && !!result.line && !hasPoint(guide, result.line);
      endAgentStep(task, { outcome: proposed ? W.guidePoint : W.noGuidePoint, reason: W.backToBuilder }, Date.now());
      if (!result.missed || !result.line) this.k.log(scope, "done", `Nothing for the review guide: ${result.why}`, "guide-keeper", ran);
      else if (hasPoint(guide, result.line)) this.k.log(scope, "done", "The review guide already has that point", "guide-keeper", ran);
      else {
        // An offer, not a stop: the task carries on while the coordinator decides.
        const state = task.state;
        this.k.raise(scope, "guide", `Add a point to ${product.name}'s review guide?`, false, { body: result.line, detail: `${result.why} It goes into ${GUIDE_FILE}, which AGENTS.md points every agent to, in Petrina or in your own sessions.` });
        task.state = state;
        this.k.log(scope, "done", `Proposed a point for the review guide: ${result.line}`, "guide-keeper", ran);
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted || error instanceof ScreenWait) throw error;
      this.k.releaseScreen(task);
      restore();
      if (error instanceof WaitingForUsage) throw error;
      // Petrina carries on without it, but it is still a failure in Analytics.
      this.k.tracking.failed(scope, error, { roleId: "guide-keeper", profileId: ran });
      endAgentStep(task, { outcome: W.couldNotFinish, reason: W.backToBuilder }, Date.now());
      this.k.log(scope, "warn", "The Guide keeper could not finish, so nothing was proposed for the review guide");
    }
    delete task.miss;
    this.k.commit();
  }

  /**
   * Accepted points reach REVIEW.md on a branch that ships: the task they came from, or else the next one to
   * reach its delivery check. AGENTS.md gets a short section pointing to the guide when it has none. Nothing is
   * running in the working copy at this point.
   */
  async writeGuide(scope: RepositoryContext): Promise<void> {
    const { task, work: repository } = scope;
    const product = this.k.productOf(scope);
    if (!product?.reviewGuide?.length || !repository.worktree) return;
    const free = (line: { writtenOn?: Id }) => !line.writtenOn || line.writtenOn === task.id || ["cancelled", "failed"].includes(this.k.task(line.writtenOn)?.state ?? "cancelled");
    let due: DeepMutable<GuideLine>[];
    try {
      const file = localPoints(repository.worktree, GUIDE_FILE);
      due = product.reviewGuide.filter((line) => !line.incorporatedOn && !hasPoint(file, line.text) && free(line));
      if (!due.length) return;
      appendPoints(repository.worktree, GUIDE, due.map((line) => line.text));
      if (!localPoints(repository.worktree, AGENTS_FILE).includes(GUIDE_FILE)) addToSection(repository.worktree, GUIDE_SECTION, GUIDE_POINTER, []);
    } catch (error) {
      this.k.log(scope, "warn", `The review guide was not updated: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await git.commitAll(repository.worktree, `Review guide: ${due.length === 1 ? "one more point" : `${due.length} more points`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina: the coordinator accepted ${due.length === 1 ? "it" : "them"} after reviewers missed something.`);
    for (const line of due) line.writtenOn = task.id;
    this.k.log(scope, "done", `Added to ${GUIDE_FILE}: ${due.map((line) => line.text).join("; ")}`);
    this.k.commit();
  }

  /** Points the coordinator accepted that the base branch's REVIEW.md does not have yet: reviewers get them with the task. */
  async pendingPoints(scope: RepositoryContext): Promise<string[]> {

    if (!this.k.productOf(scope)?.reviewGuide?.length) return [];
    return (await this.guidance(scope)).pending.map((line) => line.text);
  }

  /** The guide as the base branch has it, plus the points the coordinator accepted: what the Guide keeper weighs a new point against. */
  async reviewGuide(scope: RepositoryContext): Promise<string> {

    const { base, pending } = await this.guidance(scope);
    return pointsText(GUIDE, base, pending);
  }

  private async guidance(scope: RepositoryContext): Promise<{ base: string; pending: GuideLine[] }> {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    const root = product?.path ?? repository.worktree;
    const ref = repository.baseSha ?? repository.base;
    const base = root && ref ? ((await git.fileAt(root, ref, GUIDE_FILE)) ?? "") : "";
    const candidates = (product?.reviewGuide ?? []).filter((line) => !hasPoint(base, line.text));
    if (!root || !ref || !candidates.some((line) => line.incorporatedOn)) return { base, pending: candidates };
    const sha = repository.baseSha ?? await git.revParse(root, ref);
    const contained = new Map<string, boolean>();
    const pending: GuideLine[] = [];
    for (const line of candidates) {
      const receipt = line.incorporatedOn;
      if (sha && receipt) {
        let included = contained.get(receipt);
        if (included === undefined) {
          included = await git.contains(root, sha, receipt);
          contained.set(receipt, included);
        }
        // This base already incorporated the rule. Its later removal is authoritative.
        if (included) continue;
      }
      pending.push(line);
    }
    return { base, pending };
  }
}
