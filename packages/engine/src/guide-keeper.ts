import { GuideProposals, type RepositoryContext } from "@petrina/orchestrator";
// The review guide that learns from misses: the Guide keeper's proposals, the coordinator's yes or no,
// and accepted points reaching REVIEW.md. Reading and writing the file is in points.ts.

import { type DeepMutable, type Id, type GuideLine, type Task } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { formatFindings } from "./prompts.js";
import { GuideResult } from "./roles.js";
import { AGENTS_FILE, GUIDE, GUIDE_FILE, hasPoint, pointsText } from "@petrina/core";
import { addToSection, appendPoints, localPoints } from "./points.js";

/** What AGENTS.md says about the review guide, so every agent reads it, in Petrina or not. */
const GUIDE_SECTION = "## Review guide";
const GUIDE_POINTER = `Every change here is reviewed against ${GUIDE_FILE}: read it before you build or review one. A change is judged by the guide as the default branch has it, never by what the change itself writes there.`;
import { Kernel, Aborted, GUIDE_KEEPER_PROFILE, ScreenWait, SourceRefreshRequired } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";

export class GuideKeeper {
  private readonly proposals: GuideProposals;
  constructor(private readonly k: Kernel, turns: Turns) {
    this.proposals = new GuideProposals({
      current: () => k.s, task: id => k.task(id), productOf: target => k.productOf(target), takeItem: id => k.takeItem(id),
      profile: () => k.onUsable(GUIDE_KEEPER_PROFILE), now: () => Date.now(),
      checkpointNow: () => k.commitNow(), checkpoint: task => k.commit(task), releaseScreen: task => k.releaseScreen(task),
      offer: (scope, title, details) => { k.raise(scope, "guide", title, false, details); },
      log: (target, kind, text, roleId, profileId) => k.log(target, kind, text, roleId, profileId),
      failed: (scope, error, profileId) => k.tracking.failed(scope, error, { roleId: "guide-keeper", profileId }),
    }, {
      guide: scope => this.reviewGuide(scope),
      turn: (scope, input, profileId, signal, used) => turns.turn(scope, "guide-keeper", profileId, () => [
        { title: "The coordinator's note when sending the delivery back", body: input.note },
        { title: `The review guide now (${GUIDE_FILE})`, body: input.guide || "There is none yet." },
        ...(scope.task.findings.length ? [{ title: "What the reviewers did raise", body: formatFindings(scope.task.findings as Task["findings"]) }] : []),
      ], GuideResult, signal, { status: "Looking for what the reviewers missed", used }),
      interrupted: error => error instanceof Aborted || error instanceof ScreenWait,
      deferred: error => error instanceof WaitingForUsage || error instanceof SourceRefreshRequired,
    });
  }

  /** Coordinator decisions affect the accepted queue; native writing remains a delivery effect. */
  acceptGuideLine(itemId: Id): void { this.proposals.accept(itemId); }
  declineGuide(itemId: Id): void { this.proposals.decline(itemId); }

  /** A nonblocking side errand preserves the Builder's restart bookkeeping. */
  proposeGuideLine(scope: RepositoryContext, signal: AbortSignal): Promise<void> { return this.proposals.propose(scope, signal); }

  /**
   * Accepted points reach REVIEW.md on a branch that ships: the task they came from, or else the next one to
   * reach its delivery check. AGENTS.md gets a short section pointing to the guide when it has none. Nothing is
   * running in the working copy at this point.
   */
  async writeGuide(scope: RepositoryContext): Promise<void> {
    const { task, work: repository } = scope;
    const product = this.k.productOf(scope);
    if (!product?.reviewGuide?.length || !repository.worktree) return;
    const free = (line: { writtenOn?: Id }) => !line.writtenOn || line.writtenOn === task.id || [
      "cancelled",
      "failed"
    ].includes(this.k.task(line.writtenOn)?.state ?? "cancelled");
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
    await git.commitChanges(
      repository.worktree,
      `Review guide: ${due.length === 1 ? "one more point" : `${due.length} more points`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina: the coordinator accepted ${due.length === 1 ? "it" : "them"} after reviewers missed something.`
    );
    await this.k.rememberVersion(scope);
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
