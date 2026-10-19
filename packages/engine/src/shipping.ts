import { companionText, landingState, repositoryDelivered } from "@petrina/core";
import { api } from "./source-github.js";
// Delivering finished work, by Petrina itself, with no agent. Before anything goes out the work is one commit on
// top of the latest main, approved for this delivery and destination, with the checks passing on it. Petrina
// publishes the exact commit it checked, with what the builder wrote to go out with it: it pushes the branch and
// opens the pull request (the builder's description, then Petrina's own part), sets a release's version in the
// product's version files, pushes main and the new tag together and creates the release with the builder's
// notes, or moves the approved local branch forward and pushes it. A pull request the task started from gets the tested commit on its working branch. It has no merge, force-push or delete. Every publishing step is saved
// before it starts, and an interrupted delivery is looked up before anything goes out again: never twice.

import {
  beginPetrinaStep,
  beginYouStep,
  CLEANUP_WORDS,
  endAgentStep,
  endOpenStep,
  endPetrinaStep,
  endYouStep,
  JOURNEY_WORDS as W,
  lastIndexWhere,
  needsPullRequestCheck,
  reviewerAt,
  openStep,
  petrinaMoment,
  type DeliveryMode,
  type Id,
  type Product,
  type ShippingStep,
  type Task,
  type TaskSource,
} from "@petrina/core";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as git from "./git.js";
import { sourcePr } from "./source-github.js";
import { ReleaseNotesResult, TEXT_LIMITS } from "./roles.js";
import { WaitingForUsage } from "./usage.js";
import { Aborted, type Kernel, type MStage, type MTask, RELEASE_MANAGER_PROFILE } from "./kernel.js";
import { type Connections, Unreachable } from "./connection.js";
import type { ProductChecks } from "./product-checks.js";
import type { ToolChecks } from "./tool-checks.js";
import type { Turns } from "./turn.js";
import type { Updates } from "./update.js";
import { declaredVersion, isVersionFile, lockWithVersion, MAIN_VERSION_FILES, nextVersion, onlyVersionChanged, ownCrates, parseVersion, withVersion } from "./version.js";

/** Preparations started again because the default branch moved, before Petrina stops and asks. */
const MAX_MOVES = 3;
/** Failed preparations (the checks failing on the version commit) before Petrina stops and asks. */
const MAX_FAILURES = 2;
/** A delivery from before the update, which Petrina leaves to the coordinator. */
export const CARRIED_OVER = "This delivery was interrupted before Petrina was updated";

/** What the check before publishing found. `unknown`: GitHub could not be asked. `other`: something that is not this work is there. */
type Delivery = { found: true; text: string; record: (signal: AbortSignal) => Promise<unknown> | unknown } | { found: false; text: string } | { found: "unknown" | "other"; text: string };

/** Publishing found new source commits, after ruling out an already completed push. */
class SourceMoved extends Error {}

/** Where a delivery goes. Approval is for this destination only. */
export function destination(task: { delivery: DeliveryMode; source?: TaskSource }, product: Pick<Product, "path" | "repo" | "defaultBranch"> | undefined): string {
  if (task.source) {
    const target = task.source.destination;
    return target.kind === "update-pr" && task.source.start.kind === "pull-request" ? `${task.source.product.repo}#pr/${task.source.start.number}:${target.repo}#${target.branch}` : task.delivery === "local" ? `${task.source.product.path ?? ""}#${target.branch}` : `${target.repo}#${target.branch}`;
  }
  const branch = product?.defaultBranch ?? "main";
  return task.delivery === "local" ? `${product?.path ?? ""}#${branch}` : `${product?.repo ?? ""}#${branch}`;
}

/** The most commits a release's notes are written from, when there is no previous release to start at. */
const MAX_LOG = 200;

/** Whether the delivery step needs an agent now: only a release, for its notes, until they are written. */
export function needsReleaseManager(task: MTask): boolean {
  return task.delivery === "release" && !task.shipping?.prepared && !task.shipping?.step && !task.shipping?.carriedOver;
}

/** Text cut to fit where GitHub puts it, marked when it was cut. */
function fit(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** What the version files say, for a message: "package.json says 1.0.0, Cargo.toml says 2.0.0". */
function says(entries: readonly { file: string; version?: string }[]): string {
  return entries.map((entry) => `${entry.file} says ${entry.version ?? "something Petrina cannot read"}`).join(", ");
}

export class Shipping {
  /** Cancelled tasks whose last publishing step is being looked up. */
  private readonly looking = new Set<Id>();
  private readonly following = new Set<Id>();

  constructor(
    private readonly k: Kernel,
    private readonly turns: Turns,
    private readonly updates: Updates,
    private readonly checks: ProductChecks,
    private readonly connections: Connections,
    private readonly tools: ToolChecks,
  ) {}

  /**
   * The delivery step. Interrupted while publishing: what went out is looked up first. Otherwise the work is
   * made ready to ship, then ready to publish, then Petrina publishes it. Only a release runs an agent here, for
   * its notes. "continue": the task went somewhere else first (back to the builder or the delivery check, or main
   * moved and it gets ready again).
   */
  async deliver(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    if (task.repositories) {
      try { return await this.deliverMany(task, stage, signal); }
      finally {
        if (!this.k.stopped && ["needs-you", "paused", "failed"].includes(task.state)) await this.clearUnpublishedPreparations(task);
      }
    }
    return this.deliverOne(task, stage, signal);
  }

  private async clearUnpublishedPreparations(task: MTask): Promise<void> {
    const current = task.productId;
    for (const work of task.repositories!) {
      if (work.pr || work.release || work.landed || work.shipping?.step || work.shipping?.pushed) continue;
      this.k.selectRepository(task, work.productId);
      await this.clearUnpublishedVersion(task);
    }
    this.k.selectRepository(task, current);
  }

  private async deliverMany(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    this.k.saveRepository(task);
    for (const work of task.repositories!.filter((entry) => entry.pr?.state === "closed" && !entry.landingAccepted)) {
      const state = await git.prState(work.source!.product.repo, work.pr!.number, this.k.options.gh);
      if (state) work.pr!.state = state;
    }
    if (task.repositories!.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) { this.finishMany(task); return "stop"; }
    // Complete preparation everywhere before the first publication. Already delivered records are immutable.
    for (const work of task.repositories!) {
      if (repositoryDelivered(work)) continue;
      this.k.selectRepository(task, work.productId);
      if (task.shipping?.step) {
        if (await this.checkDelivery(task, signal) === "stop" && !repositoryDelivered(work)) return "stop";
        this.k.saveRepository(task);
        if (repositoryDelivered(work)) continue;
      }
      if (!task.shipping?.prepared) {
        if (task.delivery !== "local") await this.tools.needGitHub(task);
        if (await this.readyToShip(task, signal) === "back") return "continue";
        if (task.delivery !== "release" && task.baseSha === await git.head(task.worktree!)) {
          work.nothingToPublish = true;
          this.k.log(task, "done", `${task.source!.product.name}: Nothing to publish`);
          this.k.commitNow();
          continue;
        }
        const result = await this.prepare(task, stage, signal);
        if (result !== "ready") return result;
        this.k.saveRepository(task);
      }
    }
    const preview = companionText(task.repositories!);
    if (preview) for (const work of task.repositories!) {
      if (!work.nothingToPublish && (work.delivery === "pull-request" || work.source?.destination.kind === "update-pr")) work.companion ??= { text: preview, state: "pending" };
    }
    this.k.commitNow();
    for (const work of task.repositories!) {
      if (repositoryDelivered(work)) continue;
      this.k.selectRepository(task, work.productId);
      if (task.shipping?.prepared?.body && preview) task.shipping.prepared.body = `${task.shipping.prepared.body.replace(/\n*Part of a change across: [^\n]*$/u, "")}\n\n${preview}`;
      const result = await this.deliverOne(task, stage, signal);
      this.k.saveRepository(task);
      if (!repositoryDelivered(work)) return result;
      if (work.pr?.state === "closed" && !work.landingAccepted) { this.finishMany(task); return "stop"; }
      if (signal.aborted || task.state === "cancelled") return "stop";
      task.state = "running";
      this.k.commitNow();
    }
    // Linking has its own saved progress and recovery; it never reopens or republishes a delivery.
    const text = companionText(task.repositories!);
    if (text) for (const work of task.repositories!.filter((entry) => entry.pr)) {
      this.k.selectRepository(task, work.productId);
      if (work.companion?.state === "done" && work.companion.text === text) continue;
      work.companion = { text, state: "checking" };
      task.statusLine = `Finishing companion links for ${work.source!.product.name}`;
      this.k.commitNow();
      try {
        const repo = work.source!.product.repo;
        const number = work.pr!.number;
        const existing = work.source!.destination.kind === "update-pr";
        if (existing) {
          const comments = (await api(repo, `issues/${number}/comments?per_page=100`, this.k.options.gh)).flat() as { body?: string }[];
          if (!comments.some((comment) => comment.body === text)) {
            const posted = await git.gh(this.k.options.gh ?? ["gh"], repo, ["pr", "comment", String(number), "--body-file", "-"], text);
            if (posted.code) throw new Error(posted.stderr || "Could not confirm the companion comment.");
          }
          const confirmed = (await api(repo, `issues/${number}/comments?per_page=100`, this.k.options.gh)).flat() as { body?: string }[];
          if (!confirmed.some((comment) => comment.body === text)) throw new Error("Could not confirm the companion comment. Check again before retrying.");
        } else {
          const read = await git.gh(this.k.options.gh ?? ["gh"], repo, ["pr", "view", String(number), "--json", "body"]);
          if (read.code) throw new Error("Could not read the companion links. Check again.");
          const body = JSON.parse(read.stdout).body;
          if (typeof body !== "string") throw new Error("GitHub did not return the pull request description.");
          const next = `${body.replace(/\n*Part of a change across: [^\n]*\.?$/u, "")}\n\n${text}`;
          if (body !== next) {
            const edited = await git.gh(this.k.options.gh ?? ["gh"], repo, ["pr", "edit", String(number), "--body-file", "-"], next);
            if (edited.code) throw new Error(edited.stderr || "Could not finish companion links.");
          }
        }
        work.companion.state = "done";
        this.k.commitNow();
      } catch (error) {
        work.companion.state = "pending";
        this.k.raise(task, "stuck", "Deliveries are saved; companion links need finishing", false, { body: String(error) });
        task.statusLine = "Deliveries saved. Finish links";
        this.k.commitNow();
        return "stop";
      }
    }
    this.finishMany(task);
    return "stop";
  }

  private finishMany(task: MTask): void {
    this.k.saveRepository(task);
    const landed = landingState(task.repositories!);
    delete task.agent;
    task.holdsSlot = false;
    if (task.repositories!.every(repositoryDelivered) && task.repositories!.every((work) => !work.companion || work.companion.state === "done") && !task.deliveryRecorded) { this.k.tracking.delivered(task); task.deliveryRecorded = true; }
    if (landed === "unfinished") {
      task.state = "needs-you"; task.column = "ready"; task.statusLine = "Confirmed deliveries are saved. Unfinished deliveries need retry";
      if (!this.k.s.inbox.some((item) => item.taskId === task.id && ["stuck", "shipping"].includes(item.kind))) this.k.raise(task, "stuck", "Resume the unfinished deliveries", false);
    } else if (landed === "decision") {
      task.state = "needs-you";
      task.column = "ready";
      const names = task.repositories!.filter((work) => work.pr?.state === "closed" && !work.landingAccepted).map((work) => work.source!.product.name);
      task.statusLine = `${names.join(", ")}: pull request closed without merging. Your decision is needed`;
      if (!this.k.s.inbox.some((item) => item.taskId === task.id && item.kind === "shipping")) this.k.raise(task, "shipping", task.statusLine, false, { body: "Confirmed deliveries remain saved. Dependent tasks stay blocked until you explicitly decide this change has landed." });
    } else if (landed === "waiting") {
      task.state = "pr-open"; task.column = "ready"; task.statusLine = "Waiting for every pull request to merge";
    } else if (landed === "landed") {
      task.state = "done"; task.column = "done"; task.statusLine = "All products have landed"; task.finishedAt ??= Date.now();
    }
    this.k.commitNow();
    this.k.schedule();
  }

  /** Release previews contain text only; no version files change until shared approval. */
  async previewRelease(task: MTask, stage: MStage, signal: AbortSignal): Promise<void> {
    if (!task.repositories || task.delivery !== "release") return;
    const start = await git.head(task.worktree!);
    if (task.releasePreview?.start === start && task.releasePreview.base === task.baseSha) return;
    task.shipping = { moves: 0, failures: 0, start, base: task.baseSha };
    await this.chooseVersion(task, signal);
    const log = await this.sincePreviousRelease(task, signal);
    const result = await this.turns.turn(task, "release-manager", stage.profileIds[0] ?? RELEASE_MANAGER_PROFILE, () => [log], ReleaseNotesResult, signal);
    const shipping = task.shipping!;
    task.releasePreview = { start, base: task.baseSha, version: shipping.version!, tag: shipping.tag!, after: shipping.after!, notes: result.notes, summary: result.summary };
    delete task.shipping;
    this.k.finishStep(task);
    this.k.commitNow();
  }

  /** A known-unpublished version commit is preparation, so it never reaches an editing role. */
  async clearUnpublishedVersion(task: MTask): Promise<void> {
    if (!task.shipping?.step && !task.shipping?.pushed && task.shipping?.start) {
      await this.backToWork(task);
      delete task.shipping;
      this.k.commitNow();
    }
  }

  private async deliverOne(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    if (signal.aborted) throw new Aborted();
    if (!task.shipping?.step) {
      // Nothing starts shipping to GitHub without a GitHub login: no half-done delivery.
      if (task.delivery !== "local") await this.tools.needGitHub(task);
      if (signal.aborted) throw new Aborted();
      if (!task.shipping?.prepared) {
        if ((await this.readyToShip(task, signal)) === "back") return "continue";
        const prepared = await this.prepare(task, stage, signal);
        if (prepared !== "ready") return prepared;
      }
    }
    // Check preparation or release notes may have finished after admissions closed. Publishing
    // is its own step; an already-started delivery still settles all of its saved steps.
    if (this.k.admissionsClosed && !task.shipping?.step) throw new WaitingForUsage("Waiting for the pool to resume before publishing");
    // Petrina's own step on the journey, from its first look on GitHub until it went out.
    beginPetrinaStep(task, "delivery", Date.now());
    // Looked up before publishing, and first after an interruption: what is already there is recorded, not made again.
    try {
      if ((await this.checkDelivery(task, signal)) === "stop") return "stop";
      return (await this.publish(task, signal)) === "done" ? "stop" : "continue";
    } catch (error) {
      if (!(error instanceof SourceMoved)) throw error;
      this.stopIfAsked(signal);
      await this.prepareAgain(task, error.message);
      return "continue";
    }
  }

  // ── Ready to ship ──────────────────────────────────────────────────────

  /**
   * What ships is the change the coordinator approved, for this delivery and destination, one commit on top of
   * the latest main (freshly fetched for a GitHub delivery), with the checks passing on it. "back": the task went
   * back to the builder or the delivery check first.
   */
  private async readyToShip(task: MTask, signal: AbortSignal): Promise<"ready" | "back"> {
    // A version change from an earlier preparation is the delivery's, never the work's: it goes first.
    await this.backToWork(task);
    const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
    const backToCheck = (line: string): "back" => {
      this.clearApproval(task);
      this.clearDelivery(task);
      task.stageIndex = check;
      task.sub = 0;
      petrinaMoment(task, "delivery", { outcome: W.askAgain, reason: W.changedSinceApproval, tone: "back" }, Date.now());
      this.k.log(task, "warn", line);
      this.k.commit();
      return "back";
    };
    const allowed = task.approvedFor;
    if (allowed && (allowed.mode !== task.delivery || allowed.destination !== destination(task, this.k.repositoryOf(task)))) {
      if (check >= 0) return backToCheck("Where it goes changed after it was approved, so it needs your OK again");
      this.clearApproval(task);
    }
    // Before anything moves (an approval from before patch-ids were kept goes by its commit).
    const sourceName = task.source?.start.kind === "pull-request" ? `PR #${task.source.start.number}` : task.source?.start.branch ?? this.k.repositoryOf(task)?.defaultBranch ?? "main";
    const approved = task.approvedPatch ?? (task.approvedSha ? await this.updates.patch(task, task.approvedSha) : undefined);
    const update = await this.updates.upToDate(task, signal, true);
    if (update === "conflict") return "back";
    if (approved && check >= 0 && (await this.updates.patch(task)) !== approved) {
      return backToCheck(update === "moved" ? `${sourceName === "main" ? "Main" : sourceName} moved on, and on top of it this change reads differently from what you approved, so Petrina asks you again` : "The work changed after you approved the delivery, so Petrina asks you again");
    }
    if (await this.checks.checksBeforeShipping(task, signal)) return "back";
    return "ready";
  }

  /**
   * The delivery gets ready. A pull request takes the builder's title and description, followed by Petrina's own
   * part. A release gets its version worked out now and set by Petrina in the product's version files, as one
   * version commit it checks, the product's checks again on it, and notes from the Release Manager, who reads every commit
   * since the previous release: a release ships all of them, not only this task. Local delivery needs nothing more.
   */
  private async prepare(task: MTask, stage: MStage, signal: AbortSignal): Promise<"ready" | "continue" | "stop"> {
    const product = this.k.repositoryOf(task)!;
    const defaultBranch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    const shipping: NonNullable<MTask["shipping"]> = (task.shipping = { moves: task.shipping?.moves ?? 0, failures: task.shipping?.failures ?? 0 });
    const start = await this.branchTip(task);
    if (!start) throw new Error(`The task's branch ${task.branch} is gone, so Petrina published nothing. Send it back to the builder, or cancel it.`);
    shipping.start = start;
    if (task.baseSha) shipping.base = task.baseSha;
    if (task.delivery === "local" || task.source?.start.kind === "pull-request") {
      shipping.prepared = { tested: start, summary: `Ready to go onto ${defaultBranch}` };
      this.k.log(task, "status", `Ready to publish: ${start.slice(0, 7)}, on top of ${defaultBranch}`);
      this.k.commitNow();
      return "ready";
    }
    if (task.delivery === "pull-request") {
      shipping.prepared = { tested: start, summary: "Ready to open a pull request", title: this.pullRequestTitle(task), body: this.pullRequestBody(task) };
      this.k.log(task, "status", `Ready to publish: ${start.slice(0, 7)}, with ${task.report?.description ? "the builder's description" : "a description from the builder's report"}`);
      this.k.commitNow();
      return "ready";
    }
    await this.chooseVersion(task, signal);
    this.k.log(task, "status", `Getting the release ready: Petrina sets the version to ${shipping.version}`);
    this.k.commitNow();
    const tested = await this.setVersion(task);
    // A version commit changes what ships: the checks run on it too.
    if (tested !== start && (await this.checks.failing(task, signal))) return this.preparationFailed(task, `The product's checks fail with the version set to ${shipping.version}`, signal);
    // The notes cover everything the release ships: every commit since the previous release, this task's included.
    const preview = task.releasePreview;
    if (task.repositories && preview && (preview.start !== start || preview.version !== shipping.version || preview.tag !== shipping.tag || preview.after !== shipping.after)) {
      await this.backToWork(task);
      delete task.releasePreview;
      this.clearApproval(task);
      delete task.shipping;
      // The delivery gate can pause before it runs again. Restore every unpublished product
      // now, while the previous approval still describes the original work.
      await this.clearUnpublishedPreparations(task);
      const gate = task.plan!.stages.findIndex((entry) => entry.gate === "delivery");
      task.stageIndex = gate;
      this.k.log(task, "warn", "The release preview changed, so shared delivery approval is needed again.");
      this.k.commitNow();
      return "continue";
    }
    const log = await this.sincePreviousRelease(task, signal);
    const profileId = stage.profileIds[0] ?? RELEASE_MANAGER_PROFILE;
    let by = profileId;
    const result = preview ?? await this.turns.turn(task, "release-manager", profileId, () => [log], ReleaseNotesResult, signal, {
      used: (id) => (by = id),
      check: (value) => (!value.notes.trim() ? `"notes" is empty: write the release notes.` : value.notes.length > TEXT_LIMITS.notes ? `the release notes are longer than GitHub allows (${TEXT_LIMITS.notes} characters). Shorten them.` : undefined),
    });
    shipping.prepared = { tested, summary: result.summary, notes: result.notes.trim() };
    endAgentStep(task, { outcome: W.notes, reason: W.releaseNotesReady }, Date.now());
    // Petrina publishes from here.
    delete task.agent;
    task.holdsSlot = false;
    this.k.finishStep(task);
    this.k.say(task, "agent", `${result.summary}\n\n${this.k.describe("release-manager", by)}`, "release-manager", by);
    this.k.log(task, "done", `Ready to publish: ${tested.slice(0, 7)}, as ${shipping.tag}, with notes on everything since ${shipping.after || "the start"}`, "release-manager", by);
    this.k.commitNow();
    return "ready";
  }

  /**
   * Every commit on the default branch since the previous release, up to this task's own, oldest first, with its
   * message: what the Release Manager writes the notes from. With no previous release (or none Petrina can find here),
   * the most recent ones, at most 200, saying so.
   */
  private async sincePreviousRelease(task: MTask, signal: AbortSignal): Promise<{ title: string; body: string }> {
    const product = this.k.repositoryOf(task)!;
    const shipping = task.shipping!;
    const worktree = task.worktree!;
    const branch = product.defaultBranch ?? "main";
    let from: string | undefined;
    if (shipping.after) {
      const remote = await this.connections.requireConnection(task, signal);
      const refs = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/tags/${shipping.after}`]));
      if (!refs.ok) throw new Unreachable(`Petrina could not find ${shipping.after} on GitHub (${refs.error}), so it published nothing. Retry when GitHub is reachable.`);
      const sha = refs.value.get(`refs/tags/${shipping.after}^{}`) ?? refs.value.get(`refs/tags/${shipping.after}`);
      if (sha && (await git.revParse(worktree, sha))) from = sha;
    }
    const commits = await git.commitMessages(worktree, from ? `${from}..${shipping.start}` : shipping.start!, MAX_LOG);
    const capped = !from && commits.length >= MAX_LOG;
    const title = from
      ? `Every commit on ${branch} since ${shipping.after}, oldest first (${commits.length})`
      : `${shipping.after ? `The commit of ${shipping.after} is not in this copy, so: the` : "The first release:"} ${capped ? `${MAX_LOG} most recent commits` : "every commit"} on ${branch}, oldest first${capped ? " (older ones are left out)" : ` (${commits.length})`}`;
    return { title, body: commits.map((commit) => `### ${commit.message.split("\n")[0]}\n${commit.message.split("\n").slice(1).join("\n").trim()}`.trim()).join("\n\n") || "(none)" };
  }

  /** The pull request's title: the builder's one-line commit title, else the task's. */
  private pullRequestTitle(task: MTask): string {
    return fit((task.report?.title ?? task.title).replace(/\s+/g, " ").trim(), TEXT_LIMITS.title);
  }

  /** The builder's words, or when it wrote none, its report: what it did, and what changed for users. */
  private fromReport(task: MTask): string {
    const report = task.report;
    const changes = report?.changes.length ? `## What changed for users\n${report.changes.map((change) => `- ${change}`).join("\n")}` : "";
    return [report?.summary ?? task.title, changes].filter(Boolean).join("\n\n");
  }

  /** The pull request's description: the builder's, then Petrina's own part, which says only what Petrina saw. */
  private pullRequestBody(task: MTask): string {
    const builder = task.report?.description?.trim() || this.fromReport(task);
    const parts: string[] = ["## Checked by Petrina"];
    const acceptance = task.brief?.acceptance ?? [];
    // Ticked only where a tester checked it.
    if (acceptance.length) parts.push(`### Acceptance\n${acceptance.map((item) => (item.met === undefined ? `- ${item.text}` : `- [${item.met ? "x" : " "}] ${item.text}`)).join("\n")}`);
    const runs = task.checks?.results ?? [];
    if (runs.length) parts.push(`### Checks Petrina ran on this commit\n${runs.map((run) => `- ${run.name}: ${run.ok ? "passed" : run.timedOut ? "did not finish" : "failed"} (\`${run.command}\`)`).join("\n")}`);
    const reviewers = [...new Set((task.plan?.stages ?? []).filter((stage) => stage.kind === "review-chain").flatMap((stage) => stage.profileIds.map((profileId, position) => this.k.describe(reviewerAt(stage, position), profileId))))];
    if (reviewers.length) parts.push(`### Reviewed by\n${reviewers.map((reviewer) => `- ${reviewer}`).join("\n")}`);
    const followUps = task.findings.filter((finding) => finding.status === "open" && finding.severity === "pre-existing");
    // Only a count: an older problem a reviewer noted (a security one, say) is not for a public pull request.
    if (followUps.length) parts.push(`### Follow-ups\n${followUps.length === 1 ? "One older problem was" : `${followUps.length} older problems were`} noted for a follow-up, in Petrina.`);
    return fit(`${builder}\n\n${parts.join("\n\n")}`, TEXT_LIMITS.body);
  }

  /**
   * Petrina sets the release's version itself, in the product's main version files (and the product's own
   * entries in the Cargo.lock beside a Cargo.toml it changed), as one version commit on top of the work, and
   * checks it: only the version changed, and every main version file says it. Anything it cannot set or check
   * stops the release, with nothing published. Returns the commit to publish: the version commit, or the work
   * itself when its files already say the version (a first release, or none to set).
   */
  private async setVersion(task: MTask): Promise<string> {
    const worktree = task.worktree!;
    const shipping = task.shipping!;
    const start = shipping.start!;
    const version = shipping.version!;
    const stop = (why: string): never => {
      throw new Error(`Petrina could not set the version to ${version}: ${why}. It published nothing. Set it there yourself (only the version) in a task, or release by hand, then retry.`);
    };
    const due = (await this.declaredVersions(worktree, start)).filter((entry) => entry.version !== version);
    if (!due.length) return start;
    const before = new Map<string, string>();
    for (const { file, version: from } of due) {
      const text = (await git.fileAt(worktree, start, file))!;
      const next = withVersion(file, text, from!, version);
      if (next === undefined) return stop(`${file} does not state it in a way Petrina can change on its own`);
      before.set(file, from!);
      writeFileSync(join(worktree, file), next);
      // The product's own entries in the Cargo.lock beside it move with it.
      if (file.endsWith("Cargo.toml")) {
        const lockFile = join(dirname(file), "Cargo.lock").replace(/^\.\//, "");
        const lock = await git.fileAt(worktree, start, lockFile);
        if (lock !== undefined) {
          const moved = lockWithVersion(lock, ownCrates(text), from!, version);
          if (moved !== lock) {
            before.set(lockFile, from!);
            writeFileSync(join(worktree, lockFile), moved);
          }
        }
      }
    }
    const conventional = /^[a-z]+(\([^)]+\))?!?: /.test(task.report?.title ?? "");
    const message = `${conventional ? `chore(release): ${shipping.tag}` : `Release ${shipping.tag}`}\n\nSet the version to ${version}.\n\nBy Petrina`;
    const tested = await git.commitAll(worktree, message);
    if (!tested) return start;
    // Checked like anyone's version commit: only the version, and every main version file says it.
    const changed = await git.changedFiles(worktree, start, tested);
    const more: string[] = [];
    for (const file of changed) {
      if (!isVersionFile(file)) more.push(file);
      else {
        const [source, target] = await Promise.all([git.fileAt(worktree, start, file), git.fileAt(worktree, tested, file)]);
        if (!onlyVersionChanged(file, source, target, version, before.get(file))) more.push(file);
      }
    }
    const wrong = (await this.declaredVersions(worktree, tested)).filter((entry) => entry.version !== version);
    if (more.length || wrong.length) {
      await git.resetTo(worktree, start);
      stop(more.length ? `the change in ${more.join(", ")} would be more than the version` : `${says(wrong)}`);
    }
    return tested;
  }

  /** Releases: the latest published release plus the product's bump, worked out now, with its tag still free on GitHub. */
  private async chooseVersion(task: MTask, signal: AbortSignal): Promise<void> {
    const product = this.k.repositoryOf(task)!;
    const shipping = task.shipping!;
    const remote = await this.connections.requireConnection(task, signal);
    const latest = await this.connections.serial(product.id, () => git.latestRelease(product.repo, this.k.options.gh));
    if (!latest.ok) throw new Error(`Petrina could not read the latest release on GitHub (${latest.error}), so it published nothing. Retry when GitHub is reachable.`);
    // The product's main version files, on the work as it is now.
    const declared = await this.declaredVersions(task.worktree!, shipping.start!);
    const unreadable = declared.filter((entry) => !entry.version);
    if (unreadable.length) throw new Error(`Petrina cannot read the version in ${unreadable.map((entry) => entry.file).join(", ")}, so it published nothing. Make it a version like 1.2.3, then retry.`);
    let next: { version: string; tag: string } | undefined;
    if (latest.value) {
      const counted = nextVersion(latest.value, product.releaseBump ?? "patch");
      if (!counted) throw new Error(`The latest release is ${latest.value}, and Petrina only counts up from versions like v1.2.3, so it published nothing.`);
      // The version files follow the releases: at the latest one, or already at the next.
      const current = parseVersion(latest.value)!.version;
      const off = declared.filter((entry) => entry.version !== current && entry.version !== counted.version);
      if (off.length) throw new Error(`The latest release is ${latest.value}, but the version files say otherwise (${says(off)}), so Petrina published nothing. Make them say ${current}, or release by hand, then retry.`);
      next = counted;
    } else {
      // The first release: the version the product already declares, or 0.1.0.
      const versions = [...new Set(declared.map((entry) => entry.version!))];
      if (versions.length > 1) throw new Error(`This is the first release, but the version files disagree (${says(declared)}), so Petrina published nothing. Make them agree, then retry.`);
      const version = parseVersion(versions[0] ?? "0.1.0")!.version;
      next = { version, tag: `v${version}` };
    }
    const tags = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/tags/${next.tag}`]));
    if (!tags.ok) throw new Error(`Petrina could not check GitHub for the tag ${next.tag} (${tags.error}), so it published nothing. Retry when GitHub is reachable.`);
    if (tags.value.size) throw new Error(`The tag ${next.tag} already exists on GitHub, but no release follows ${latest.value ?? "it"}. Petrina stopped rather than skip a version, and published nothing. Publish that release or remove the tag on GitHub, then retry.`);
    shipping.version = next.version;
    shipping.tag = next.tag;
    shipping.after = latest.value ?? "";
  }

  /** What the product's main version files say at a commit: those that state a version, and those Petrina cannot read (no `version`). */
  private async declaredVersions(path: string, sha: string): Promise<{ file: string; version?: string }[]> {
    const found: { file: string; version?: string }[] = [];
    for (const file of MAIN_VERSION_FILES) {
      const text = await git.fileAt(path, sha, file);
      if (text === undefined) continue;
      const declared = declaredVersion(file, text);
      if (declared === "unreadable") found.push({ file });
      else if (declared !== "none") found.push({ file, version: declared.version });
    }
    return found;
  }

  /** A release's version commit on top of `start`: one parent, and only version files changed. */
  private async isVersionCommit(path: string, sha: string, start: string): Promise<boolean> {
    const parents = await git.parents(path, sha);
    if (parents.length !== 1 || parents[0] !== start) return false;
    const changed = await git.changedFiles(path, start, sha);
    return changed.length > 0 && changed.every(isVersionFile);
  }

  /**
   * Not ready (the product's checks fail with the version set): nothing is published, and main and GitHub stay
   * as they were. The version change goes, and the task goes back to the builder, then review and the delivery
   * check again. After two failures Petrina stops and asks. Shared tasks keep their approval and return to
   * the delivery check instead; the coordinator can retry preparation or ask for changes.
   */
  private async preparationFailed(task: MTask, summary: string, signal: AbortSignal): Promise<"continue" | "stop"> {
    const shipping = task.shipping!;
    await this.backToWork(task);
    const failures = shipping.failures + 1;
    const reason = /[.!?]$/.test(summary.trim()) ? summary.trim() : `${summary.trim()}.`;
    if (task.repositories) {
      // Only delivery preparation changed. Keep the reviewed work and its approval; no builder owns this failure.
      delete task.shipping;
      this.k.clearStep(task);
      this.k.saveRepository(task);
      await this.clearUnpublishedPreparations(task);
      // Check the restored work, so failures belonging only to the removed version do not reach a builder.
      await this.checks.failing(task, signal);
      this.k.saveRepository(task);
      const delivery = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
      if (delivery < 0) throw new Error("The plan has no delivery check before release preparation");
      task.stageIndex = delivery;
      task.sub = 0;
      const problem = `${this.k.repositoryOf(task)!.name}: getting the release ready failed. ${reason} Nothing was published. Your approved work is saved; try delivery again or send it back with a note.`;
      this.k.log(task, "warn", problem);
      this.k.gate(task, "delivery", problem);
      return "stop";
    }
    task.findings.push({ id: this.k.id(task.id), text: `Getting the delivery ready failed, so nothing was published: ${reason}`, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
    task.shipping = { moves: 0, failures };
    this.clearApproval(task);
    delete task.agent;
    // Nothing was handed back, so no record for estimates.
    this.k.clearStep(task);
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry) => entry.roleId === "builder" && entry.kind === "do");
    if (builder >= 0) {
      task.stageIndex = builder;
      task.sub = 0;
      task.fixing = true;
    }
    this.k.log(task, "warn", `Not ready to publish: ${reason} Nothing was published; it goes back to the builder.`);
    this.k.commitNow();
    if (failures < MAX_FAILURES && builder >= 0) return "continue";
    this.k.fail(task.id, new Error(`Getting the delivery ready failed ${failures} times, so Petrina stopped and published nothing. The last reason: ${reason} Try again to send it back to the builder, or cancel it.`));
    return "stop";
  }

  /** The default branch moved before a release or local delivery went out: Petrina gets it ready again. */
  private async prepareAgain(task: MTask, why: string): Promise<"again"> {
    const shipping = task.shipping!;
    const branch = task.source?.start.branch ?? this.k.repositoryOf(task)?.defaultBranch ?? "main";
    if (shipping.moves >= MAX_MOVES) {
      // A Retry gets a fresh set of attempts.
      shipping.moves = 0;
      this.k.commitNow();
      throw new Error(`${why} again: ${branch} kept moving while Petrina was delivering, so it stopped after ${MAX_MOVES} new preparations and published nothing. Retry when it is quiet.`);
    }
    // The version change goes: the work is brought up to date again, and gets a fresh version.
    await this.backToWork(task);
    task.shipping = { ...(shipping.start ? { start: shipping.start } : {}), moves: shipping.moves + 1, failures: shipping.failures };
    const place = task.source?.start.kind === "pull-request" ? `PR #${task.source.start.number}` : branch;
    endPetrinaStep(task, { outcome: place === "main" ? W.mainMovedOn : `${place} moved on`, reason: W.readyAgain }, Date.now());
    this.k.log(task, "warn", `${why}, so Petrina gets it ready again (${shipping.moves + 1} of ${MAX_MOVES})`);
    this.k.commitNow();
    return "again";
  }

  /**
   * The working copy on the task branch, with nothing half done, and the work itself at its tip: a release's
   * version commit from an earlier preparation goes.
   */
  private async backToWork(task: MTask): Promise<void> {
    const worktree = task.worktree!;
    await git.discardChanges(worktree);
    if ((await git.currentBranch(worktree)) !== task.branch) {
      const switched = await git.switchTo(worktree, task.branch!);
      if (!switched.ok) throw new Error(`Petrina could not put the working copy back on ${task.branch} (${switched.error}), so it published nothing.`);
    }
    const start = task.shipping?.start;
    const tip = await this.branchTip(task);
    if (start && tip && tip !== start && (await this.isVersionCommit(worktree, tip, start))) await git.resetTo(worktree, start);
  }

  /** Where the task branch itself points: never just what a working copy has open. */
  private branchTip(task: MTask): Promise<string | undefined> {
    return git.revParse(task.worktree!, `refs/heads/${task.branch!}`);
  }

  private clearApproval(task: MTask): void {
    delete task.approvedSha;
    delete task.approvedPatch;
    delete task.approvedFor;
  }

  /** Nothing actionable left: the next delivery starts from a fresh preparation. Failures still count. */
  clearDelivery(task: MTask): void {
    if (task.shipping) task.shipping = { moves: 0, failures: task.shipping.failures };
  }

  // ── Publishing ─────────────────────────────────────────────────────────

  private async publish(task: MTask, signal: AbortSignal): Promise<"done" | "again"> {
    if (task.source?.start.kind === "pull-request") return this.publishPrUpdate(task, signal);
    if (task.source?.start.kind === "branch" && task.delivery !== "release" && !(await this.sourceCurrent(task, signal))) return this.prepareAgain(task, "The approved starting branch moved on GitHub");
    if (task.delivery === "pull-request") return this.publishPullRequest(task, signal);
    if (task.delivery === "release") return this.publishRelease(task, signal);
    return this.publishLocal(task, signal);
  }

  /** Saved before the step starts: a restart, pause or Retry looks its result up before doing anything. */
  private saveStep(task: MTask, step: ShippingStep, status: string): void {
    task.shipping!.step = step;
    task.shipping!.boot = this.k.boot;
    task.statusLine = status;
    this.k.commitNow();
  }

  /**
   * One publishing step, in line with the product's other git steps. Pause and cancel are checked when the step
   * actually starts, not when it joins the line, and it is saved right before it runs.
   */
  private publishStep<T>(task: MTask, signal: AbortSignal, step: ShippingStep, status: string, run: () => Promise<T>): Promise<T> {
    return this.connections.serial(task.productId, () => {
      if (signal.aborted) throw new Aborted();
      this.saveStep(task, step, status);
      return run();
    });
  }

  /** Pause and cancel stop before the next step. What went out as a task was cancelled is looked up once its driver ends. */
  private stopIfAsked(signal: AbortSignal): void {
    if (signal.aborted) throw new Aborted();
  }

  private checking(task: MTask, status: string): void {
    if (task.state === "cancelled") return;
    task.statusLine = status;
    this.k.commit();
  }

  private async publishPullRequest(task: MTask, signal: AbortSignal): Promise<"done"> {
    const product = this.k.repositoryOf(task)!;
    const prepared = task.shipping!.prepared!;
    const branch = task.branch!;
    const remote = await this.connections.requireConnection(task, signal);
    // The branch on GitHub holds the tested commit already, or nothing Petrina would overwrite.
    const there = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`]));
    if (!there.ok) throw new Unreachable(`Petrina could not check this task's branch on GitHub (${there.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    const at = there.value.get(`refs/heads/${branch}`);
    if (at && at !== prepared.tested && !(await git.contains(product.path!, prepared.tested, at))) {
      throw new Error(`GitHub has this task's branch at ${at.slice(0, 7)}, which is not this work, so Petrina pushed nothing. Look at it on GitHub, then retry or cancel.`);
    }
    // GitHub's listing showed no pull request for this work. The same push again overwrites nothing.
    const pushed = await this.publishStep(task, signal, "push", "Publishing: pushing the branch to GitHub", () => git.push(product.path!, remote, [{ sha: prepared.tested, ref: `refs/heads/${branch}` }]));
    this.stopIfAsked(signal);
    if (!pushed.ok) throw new Error(`GitHub refused the push of this task's branch, so no pull request was opened (${pushed.error}). Retry once that is sorted.`);
    this.k.log(task, "status", `Petrina pushed the branch at ${prepared.tested.slice(0, 7)}`);
    const opened = await this.publishStep(task, signal, "open", "Publishing: opening the pull request", () =>
      git.openPullRequest(product.repo, { head: branch, base: task.source?.destination.branch ?? product.defaultBranch ?? "main", title: prepared.title!.trim(), body: prepared.body! }, this.k.options.gh),
    );
    this.stopIfAsked(signal);
    if (!opened.ok && !opened.exists) throw new Error(`GitHub did not open the pull request (${opened.error}). Retry: Petrina looks for it on GitHub before opening another.`);
    // Checked on GitHub itself: from this branch, into the default branch, at the tested commit.
    const pr = await this.findPullRequest(task);
    if (!pr) {
      throw new Error(
        opened.ok
          ? "GitHub said it opened the pull request, but Petrina cannot find it for this branch and commit. Retry to check again."
          : `GitHub says a pull request already exists for this branch, but none matches this work (${opened.error}). Look at it on GitHub, then retry or cancel.`,
      );
    }
    return this.recordPr(task, pr, "opened");
  }

  /** GitHub's listing for the task's branch: the pull request for this work, none, or a stop for anything else there. */
  private async findPullRequest(task: MTask, cancelled = false): Promise<git.PullRequestInfo | undefined> {
    const product = this.k.repositoryOf(task)!;
    const tested = task.shipping!.prepared!.tested;
    const defaultBranch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    this.checking(task, "Checking: looking for the pull request on GitHub");
    const listed = await this.connections.serial(product.id, () => git.pullRequests(product.repo, task.branch!, this.k.options.gh));
    if (!listed.ok) throw new Unreachable(`Petrina could not check GitHub for this task's pull request (${listed.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    const ours = listed.value.filter((pr) => pr.head === task.branch && !pr.fork);
    // Cancellation publishes nothing more. Any open pull request from this branch needs its copy,
    // even when someone changed its base or added commits while the last publishing step was stopping.
    if (cancelled) return ours.find((pr) => pr.state === "open") ?? ours.find((pr) => pr.base === defaultBranch && pr.commit === tested);
    let match: git.PullRequestInfo | undefined;
    for (const pr of ours) {
      if (await this.matchesPullRequest(task, pr, tested, defaultBranch)) { match = pr; break; }
    }
    const other = ours.find((pr) => pr !== match);
    if (other) {
      throw new Error(
        `GitHub already has pull request #${other.number} from this task's branch, but it is not this work (${other.base !== defaultBranch ? `it goes into ${other.base}` : `it is at ${other.commit.slice(0, 7)}, not ${tested.slice(0, 7)}`}). Petrina published nothing more. Look at it on GitHub, then retry or cancel.`,
      );
    }
    return match;
  }

  /** A reused branch name is not evidence of this delivery: its checked work and base must match. */
  private async matchesPullRequest(task: MTask, pr: git.PullRequestInfo, tested: string, base: string): Promise<boolean> {
    if (pr.base !== base) return false;
    if (pr.commit === tested) return true;
    const remote = this.connections.savedRemote(task);
    const tip = await this.remoteTip(task, remote, task.branch!);
    return tip === pr.commit && await this.remoteContains(task, remote, task.branch!, tip, tested);
  }

  private async publishRelease(task: MTask, signal: AbortSignal): Promise<"done" | "again"> {
    const product = this.k.repositoryOf(task)!;
    const shipping = task.shipping!;
    const { tested, notes } = shipping.prepared!;
    const tag = shipping.tag!;
    const branch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    const root = product.path!;
    const remote = await this.connections.requireConnection(task, signal);
    if (!shipping.pushed) {
      this.checking(task, `Checking: looking at ${branch} and the tag ${tag} on GitHub`);
      const before = await this.releaseRefs(task, remote);
      if (before.tag === tested && (await this.onGitHub(task, remote, before.main, tested))) {
        this.k.log(task, "status", `Checked: ${branch} and the tag ${tag} are already on GitHub at ${tested.slice(0, 7)}`);
      } else {
        if (before.tag === tested) throw new Error(`The tag ${tag} is on GitHub at the tested commit, but ${branch} there does not have it. Petrina published nothing more. Look at it on GitHub, then retry or cancel.`);
        // A moved default branch or a newer release make this preparation and its version stale.
        if (before.main !== shipping.base && before.main !== tested) return this.prepareAgain(task, `${branch} moved on GitHub`);
        const latest = await this.connections.serial(product.id, () => git.latestRelease(product.repo, this.k.options.gh));
        if (!latest.ok) throw new Error(`Petrina could not read the latest release on GitHub (${latest.error}), so it published nothing. Retry when GitHub is reachable.`);
        if ((latest.value ?? "") !== shipping.after) return this.prepareAgain(task, latest.value ? `${latest.value} came out meanwhile` : "The latest release changed meanwhile");
        if (before.tag) throw new Error(`The tag ${tag} already exists on GitHub at another commit. Petrina will not move or reuse it, and published nothing more. Look at it on GitHub, then retry or cancel.`);
        // One push, all or nothing, never forced: it only moves the branch forward and refuses an existing tag.
        const pushed = await this.publishStep(task, signal, "push", `Publishing: pushing ${branch} and the tag ${tag} to GitHub`, () =>
          git.push(
            root,
            remote,
            [
              { sha: tested, ref: `refs/heads/${branch}` },
              { sha: tested, ref: `refs/tags/${tag}` },
            ],
            true,
          ),
        );
        if (!pushed.ok) {
          const after = await this.releaseRefs(task, remote);
          if (!(after.tag === tested && (await this.onGitHub(task, remote, after.main, tested)))) {
            if (!after.tag && after.main !== shipping.base && after.main !== tested) return this.prepareAgain(task, `${branch} moved on GitHub`);
            throw new Error(`GitHub refused the push of ${branch} and the tag ${tag}, so Petrina published nothing (${pushed.error}). Retry once that is sorted.`);
          }
        }
        this.k.log(task, "status", `Petrina pushed ${branch} and the tag ${tag} at ${tested.slice(0, 7)}`);
      }
      // From here the version and commit stay, even if the default branch moves on.
      shipping.pushed = true;
      this.k.commitNow();
      this.stopIfAsked(signal);
    }
    // Retry and Ship it again come straight here: the release goes only on a tag still at the tested commit.
    this.checking(task, `Checking: looking at the tag ${tag} on GitHub`);
    const at = await this.releaseRefs(task, remote);
    if (at.tag !== tested) {
      throw new Error(`The tag ${tag} on GitHub ${at.tag ? `is at ${at.tag.slice(0, 7)}` : "is gone"}, not at the tested commit ${tested.slice(0, 7)}, so Petrina created no release. Look at it on GitHub, then retry or cancel.`);
    }
    // GitHub showed no release for this tag. Release creation only uses the tag already on GitHub.
    const created = await this.publishStep(task, signal, "release", `Publishing: creating the release ${tag}`, () => git.createRelease(product.repo, tag, notes!, this.k.options.gh));
    this.stopIfAsked(signal);
    if (!created.ok && !created.exists) throw new Error(`GitHub did not create the release ${tag} (${created.error}). Retry: Petrina looks for it on GitHub before creating another.`);
    const release = await this.findRelease(task);
    if (!release) throw new Error(`GitHub ${created.ok ? "said it created" : "says it already has"} the release ${tag}, but Petrina cannot find it. Retry to check again.`);
    // Checked on GitHub itself: the tag is at the tested commit.
    const verified = await this.releaseRefs(task, remote);
    if (verified.tag !== tested) throw new Error(`The release ${tag} is on GitHub, but its tag is not at the tested commit ${tested.slice(0, 7)}. Look at it on GitHub.`);
    return this.recordRelease(task, release, "published");
  }

  /** Where the default branch and the release's tag are on GitHub, asked of GitHub itself. */
  private async releaseRefs(task: MTask, remote: git.Remote): Promise<{ main?: string; tag?: string }> {
    const product = this.k.repositoryOf(task)!;
    const branch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    const tag = task.shipping!.tag!;
    const refs = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`, `refs/tags/${tag}`]));
    if (!refs.ok) throw new Unreachable(`Petrina could not check ${branch} and the tag ${tag} on GitHub (${refs.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    const main = refs.value.get(`refs/heads/${branch}`);
    const at = refs.value.get(`refs/tags/${tag}^{}`) ?? refs.value.get(`refs/tags/${tag}`);
    return { ...(main ? { main } : {}), ...(at ? { tag: at } : {}) };
  }

  /** Is `sha` in the history of the default branch on GitHub, now at `at`? */
  private async onGitHub(task: MTask, remote: git.Remote, at: string | undefined, sha: string): Promise<boolean> {
    if (!at) return false;
    if (at === sha) return true;
    const product = this.k.repositoryOf(task)!;
    const fetched = await this.connections.serial(product.id, () => git.fetchBranch(product.path!, remote, product.defaultBranch ?? "main"));
    if (!fetched.ok) throw new Unreachable(`Petrina could not check ${product.defaultBranch ?? "main"} on GitHub (${this.connections.why(task, fetched)}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    return git.contains(product.path!, fetched.sha, sha);
  }

  private async findRelease(task: MTask): Promise<{ tag: string; url: string } | undefined> {
    const product = this.k.repositoryOf(task)!;
    const tag = task.shipping!.tag!;
    this.checking(task, `Checking: looking for the release ${tag} on GitHub`);
    const found = await this.connections.serial(product.id, () => git.findRelease(product.repo, tag, this.k.options.gh));
    if (!found.ok) throw new Unreachable(`Petrina could not check GitHub for the release ${tag} (${found.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    if (found.value && (found.value.tag !== tag || found.value.draft)) throw new Error(`GitHub has a ${found.value.draft ? "draft " : ""}release for ${tag} that Petrina did not publish. Look at it on GitHub, then retry or cancel.`);
    return found.value ? { tag: found.value.tag, url: found.value.url } : undefined;
  }

  /** Local update and its push have separate saved evidence. */
  private async publishLocal(task: MTask, signal: AbortSignal): Promise<"done" | "again"> {
    const product = this.k.repositoryOf(task)!;
    const shipping = task.shipping!;
    const { tested } = shipping.prepared!;
    const branch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    const root = product.path!;
    // Coordinated with the product's other git steps: nothing else moves its branches meanwhile.
    const outcome = await this.connections.serial(product.id, async (): Promise<"found" | "moved" | { again: string }> => {
      this.checking(task, `Checking: looking at ${branch} in the main copy`);
      const current = await git.revParse(root, `refs/heads/${branch}`);
      if (current && (current === tested || (await git.contains(root, current, tested)))) return "found";
      const previous = task.localUpdate?.pushed === false && task.localUpdate.branch === branch && task.localUpdate.sha === current;
      if (current && !previous && current !== shipping.base && !(shipping.base && await git.contains(root, shipping.base, current))) return { again: `${branch} moved in the main copy` };
      const places = current ? (await git.checkedOut(root, branch)).map((place) => realPath(place)) : [];
      const here = places.includes(realPath(root));
      const elsewhere = places.filter((place) => place !== realPath(root));
      if (elsewhere.length) throw new Error(`${branch} is checked out in another folder (${elsewhere[0]}), so Petrina did not move it. Switch that folder to another branch, then retry.`);
      if (here && (await git.changes(root, true)).length) throw new Error(`The main copy at ${root} has changes that are not committed, so Petrina did not move ${branch}. Commit them or put them aside, then retry.`);
      this.stopIfAsked(signal);
      this.saveStep(task, "update", `Publishing: moving ${branch} forward to the tested work`);
      const moved = current ? previous ? await git.replaceLocalDelivery(root, branch, current, tested, here) : await git.fastForward(root, branch, current, tested, here) : await git.createBranchAt(root, branch, tested);
      if (!moved.ok) {
        const now = await git.revParse(root, `refs/heads/${branch}`);
        if (now !== current && now !== tested) return { again: `${branch} moved in the main copy` };
        throw new Error(`Git would not move ${branch} forward, so Petrina published nothing (${moved.error}). Retry once that is sorted.`);
      }
      this.stopIfAsked(signal);
      return "moved";
    });
    if (typeof outcome !== "string") return this.prepareAgain(task, outcome.again);
    return this.landLocal(task, signal, tested, outcome);
  }

  /**
   * The approved local branch has the tested work: checked in the main copy itself, then pushed to the saved
   * GitHub address when the product has one, and only then recorded as landed. A product with no GitHub
   * repository, or whose address the coordinator refused, lands locally and that is all.
   */
  private async landLocal(task: MTask, signal: AbortSignal, tested: string, how?: "found" | "moved"): Promise<"done"> {
    const product = this.k.repositoryOf(task)!;
    const branch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    await this.verifyLocal(product.path!, branch, tested);
    if (task.shipping) task.shipping.localUpdated = tested;
    const connection = await this.connections.connection(task, signal);
    const github = connection.ok && !!product.remote && git.sameRepo(product.remote, product.repo) && !product.repo.startsWith("local/");
    // Saved before the push, so a cancelled or refused send stays unfinished instead of looking delivered.
    if (github || task.localUpdate) {
      task.localUpdate = { branch, sha: tested, pushed: false };
      this.k.commitNow();
    }
    if (task.localUpdate) {
      const reached = await this.pushMain(task, signal, branch, tested);
      if (!reached) throw new Error(`${branch} has the work in the main copy, but Petrina could not push it to GitHub. The checked work is preserved. Retry after access is restored.`);
      task.localUpdate.pushed = true;
      this.k.commitNow();
    }
    return this.recordLanded(task, branch, tested, how);
  }

  /** Checked in the main copy itself: the branch has the tested work, and its files match when it is checked out there. Returns where the branch is. */
  private async verifyLocal(root: string, branch: string, tested: string): Promise<string> {
    const at = await git.revParse(root, `refs/heads/${branch}`);
    if (!at || !(await git.contains(root, at, tested))) throw new Error(`${branch} in the main copy does not have the tested work. Retry to check again.`);
    const here = (await git.checkedOut(root, branch)).some((place) => realPath(place) === realPath(root));
    if (here && ((await git.head(root)) !== at || (await git.changes(root, true)).length)) throw new Error(`${branch} has the tested work, but the files in the main copy at ${root} do not match it. Look at the main copy.`);
    return at;
  }

  /**
   * Only the saved tested commit is pushed. Newer local commits stay local until checked in their own right.
   * A destination already containing this commit needs no push; divergent history is never overwritten.
   * True only when GitHub has this commit. A check that cannot send is false, never a completed push.
   */
  private async pushMain(task: MTask, signal: AbortSignal, branch: string, at: string): Promise<boolean> {
    const product = this.k.repositoryOf(task)!;
    const connection = await this.connections.connection(task, signal);
    if (!connection.ok) {
      if (!connection.missing) this.k.log(task, "warn", `${branch} was not pushed to GitHub: ${connection.reason}`);
      return false;
    }
    const ref = `refs/heads/${branch}`;
    const there = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, connection.remote, [ref]));
    if (!there.ok) throw new Unreachable(`Petrina could not check ${branch} on GitHub (${there.error}). Retry before publishing anything more.`);
    if (await this.remoteContains(task, connection.remote, branch, there.value.get(ref), at)) return true;
    const checkMovement = async (tip: string | undefined): Promise<void> => {
      const base = task.shipping?.base;
      if (!tip && task.source?.start.kind === "branch") throw new Error(`${branch} is no longer available on GitHub. The checked work is preserved; nothing more was published.`);
      if (tip && base && tip !== base && !(await git.contains(product.path!, base, tip))) {
        if (await git.contains(product.path!, tip, base)) throw new SourceMoved(`${branch} moved on GitHub`);
        throw new Error(`${branch} on GitHub has divergent history. The checked work is preserved; bring the destination copies into agreement before retrying.`);
      }
    };
    await checkMovement(there.value.get(ref));
    this.stopIfAsked(signal);
    const pushed = await this.publishStep(task, signal, "push", `Publishing: pushing ${branch} to GitHub`, () => git.push(product.path!, connection.remote, [{ sha: at, ref }]));
    if (!pushed.ok) {
      const tip = await this.remoteTip(task, connection.remote, branch);
      if (await this.remoteContains(task, connection.remote, branch, tip, at)) return true;
      await checkMovement(tip);
      throw new Error(`${branch} has the work in the main copy, but Petrina could not push it to GitHub (${pushed.error}). The checked work is preserved. Retry after access is restored.`);
    }
    this.k.log(task, "done", `Petrina pushed ${branch} to GitHub (${at.slice(0, 7)})`);
    return true;
  }

  private destinationRemote(task: MTask): git.Remote {
    const source = task.source!;
    const target = source.destination;
    if (!target.remote || !git.sameRepo(target.remote, target.repo)) throw new Error("The approved working repository has no usable saved GitHub address.");
    const local = this.k.options.sourceRemotes?.[target.repo] ?? (target.repo === source.product.repo ? this.k.options.remote : undefined);
    return local ? { url: local, local: true } : { url: target.remote };
  }

  private async approvedPr(task: MTask): Promise<Awaited<ReturnType<typeof sourcePr>>> {
    const source = task.source!;
    if (source.start.kind !== "pull-request") throw new Error("No approved pull request.");
    const number = source.start.number;
    const pr = await this.connections.serial(task.productId, () => sourcePr(source.product.repo, number, this.k.options.gh));
    if (pr.headRepo.toLowerCase() !== source.start.headRepo.toLowerCase() || pr.branch !== source.start.branch) throw new Error("The pull request's working repository or branch changed. The work is preserved and its destination was not changed.");
    return pr;
  }

  /** A PR's existence alone proves nothing: its head must contain the exact tested commit. */
  private async prContains(task: MTask, pr: Awaited<ReturnType<typeof sourcePr>>, tested: string): Promise<boolean> {
    if (pr.head === tested) return true;
    const product = this.k.repositoryOf(task)!;
    const ref = `refs/petrina/evidence/${task.id}`;
    const result = await this.connections.serial(product.id, () => git.fetchRef(product.path!, this.connections.savedRemote(task), `refs/pull/${pr.number}/head`, ref));
    if (!result.ok) throw new Unreachable(`Could not confirm the tested work in PR #${pr.number}. Retry to check again; no further publishing will happen.`);
    if (result.sha !== pr.head) throw new Unreachable(`PR #${pr.number} changed while Petrina was checking it. Retry to confirm which work reached it.`);
    return git.contains(product.path!, result.sha, tested);
  }

  private async remoteTip(task: MTask, remote: git.Remote, branch: string): Promise<string | undefined> {
    const product = this.k.repositoryOf(task)!;
    const result = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`]));
    if (!result.ok) throw new Unreachable(`Could not check the approved destination (${result.error}). No further publishing will happen until Retry confirms it.`);
    return result.value.get(`refs/heads/${branch}`);
  }

  private async remoteContains(task: MTask, remote: git.Remote, branch: string, tip: string | undefined, tested: string): Promise<boolean> {
    if (!tip) return false;
    const root = this.k.repositoryOf(task)!.path!;
    if (tip === tested) return true;
    const ref = `refs/petrina/deliveries/${task.id}`;
    const fetched = await this.connections.serial(task.productId, () => git.fetchRef(root, remote, `refs/heads/${branch}`, ref));
    if (!fetched.ok) throw new Unreachable(`Could not confirm the tested work at its destination (${this.connections.why(task, fetched)}). Retry to check again.`);
    return git.contains(root, fetched.sha, tested);
  }

  private async sourceCurrent(task: MTask, signal: AbortSignal): Promise<boolean> {
    const connection = await this.connections.connection(task, signal);
    if (!connection.ok) { if (connection.missing && task.delivery === "local") return true; throw new Error(connection.reason); }
    const branch = task.source?.start.branch ?? this.k.repositoryOf(task)?.defaultBranch ?? "main";
    const tip = await this.remoteTip(task, connection.remote, branch);
    if (!tip) throw new Error(`${branch} is no longer available on GitHub. The work is preserved and nothing more was published.`);
    // A local destination may be ahead of GitHub already.
    return tip === task.shipping!.base || await git.contains(this.k.repositoryOf(task)!.path!, task.shipping!.base!, tip);
  }

  private async publishPrUpdate(task: MTask, signal: AbortSignal): Promise<"done" | "again"> {
    const pr = await this.approvedPr(task);
    if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. No more commits will be published; the work is preserved.`);
    const remote = this.destinationRemote(task);
    const { tested } = task.shipping!.prepared!;
    const at = await this.remoteTip(task, remote, pr.branch);
    if (!at) throw new Error(`The working branch for PR #${pr.number} is unavailable. The work is preserved.`);
    if (await this.remoteContains(task, remote, pr.branch, at, tested)) return this.recordPr(task, pr, "updated");
    if (at !== task.shipping!.base) return this.prepareAgain(task, `PR #${pr.number}'s working branch moved`);
    const pushed = await this.publishStep(task, signal, "push", `Publishing: updating PR #${pr.number} in ${pr.headRepo} · ${pr.branch}`, () => git.push(this.k.repositoryOf(task)!.path!, remote, [{ sha: tested, ref: `refs/heads/${pr.branch}` }]));
    this.stopIfAsked(signal);
    const after = await this.remoteTip(task, remote, pr.branch);
    if (await this.remoteContains(task, remote, pr.branch, after, tested)) return this.recordPr(task, pr, "updated");
    if (after !== at) return this.prepareAgain(task, `PR #${pr.number}'s branch moved during publishing`);
    throw new Error(`GitHub refused the update to PR #${pr.number} in ${pr.headRepo} · ${pr.branch} (${pushed.ok ? "the tested work could not be confirmed" : pushed.error}). The work is preserved. Retry after access is restored.`);
  }

  // ── What went out ──────────────────────────────────────────────────────

  /**
   * The one check before Petrina publishes, and after any interruption: record the delivery if it already
   * went out, carry on when GitHub clearly has nothing, and otherwise publish nothing more on its own. An
   * interrupted delivery asks the coordinator; a new one waits for Retry.
   */
  private async checkDelivery(task: MTask, signal: AbortSignal): Promise<"continue" | "stop"> {
    const shipping = task.shipping!;
    const interrupted = shipping.step !== undefined;
    const when = interrupted && shipping.boot !== this.k.boot ? " after a restart" : "";
    if (interrupted) {
      task.statusLine = "Checking whether it already went out";
      this.k.commit();
    }
    const delivery = await this.lookForDelivery(task);
    if (signal.aborted) throw new Aborted();
    if (delivery.found === true) {
      this.k.log(task, "done", `Found${when} that it had already gone out: ${delivery.text}`);
      await delivery.record(signal);
      return "stop";
    }
    if (delivery.found === false) {
      if (interrupted) this.k.log(task, "status", `Checked${when}: ${delivery.text} Petrina carries on publishing.`);
      return "continue";
    }
    if (!interrupted) throw delivery.found === "unknown" ? new Unreachable(delivery.text) : new Error(delivery.text);
    delete task.agent;
    task.holdsSlot = false;
    task.statusLine = "Shipping was interrupted. Your call";
    endPetrinaStep(task, { outcome: W.interrupted, reason: W.shippingInterrupted, tone: "back" }, Date.now());
    beginYouStep(task, "shipping", Date.now());
    this.k.raise(task, "shipping", `Shipping “${task.title}” was interrupted`, false, {
      body: `${delivery.text} Petrina will not publish it again on its own: check again, ship it again (it gets ready again, and Petrina checks GitHub before publishing), or mark it as done if it went out another way.`,
    });
    this.k.log(task, "warn", `Shipping was interrupted${when}. ${delivery.text}`);
    this.k.commitNow();
    return "stop";
  }

  /**
   * Is the prepared delivery already out? Asked of GitHub for the product's own repository (never through a
   * working copy's remote), or of the main copy for local delivery. Only a clear "not there" counts as
   * nothing published; a lookup that fails is never taken for an empty answer.
   */
  private async lookForDelivery(task: MTask): Promise<Delivery> {
    const product = this.k.repositoryOf(task)!;
    const shipping = task.shipping!;
    const { tested } = shipping.prepared!;
    const branch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    try {
      if (task.source?.start.kind === "pull-request") {
        const pr = await this.approvedPr(task);
        if (await this.prContains(task, pr, tested)) return { found: true, text: `Updated PR #${pr.number}`, record: () => this.recordPr(task, pr, "updated") };
        const remote = this.destinationRemote(task);
        const at = await this.remoteTip(task, remote, pr.branch);
        if (await this.remoteContains(task, remote, pr.branch, at, tested)) return { found: true, text: `Updated PR #${pr.number}`, record: () => this.recordPr(task, pr, "updated") };
        if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. The task's work is preserved; nothing more will be published.`);
        if (!at) throw new Error(`The approved pull request working branch is unavailable. The task's work is preserved.`);
        return { found: false, text: `PR #${pr.number} does not contain the tested work yet.` };
      }
      if (task.delivery === "pull-request") {
        const pr = await this.findPullRequest(task, task.state === "cancelled");
        if (pr) return { found: true, text: `pull request #${pr.number}`, record: () => this.recordPr(task, pr) };
        return { found: false, text: "No pull request is open for this work yet." };
      }
      if (task.delivery === "release") {
        const release = await this.findRelease(task);
        if (!release) return { found: false, text: `There is no release ${shipping.tag} on GitHub yet.` };
        // Checked on GitHub itself: the release's tag is at the tested commit.
        const refs = await this.releaseRefs(task, this.connections.savedRemote(task));
        if (refs.tag !== tested) {
          // Before Petrina's push, someone else's release makes this version stale: publishing gets it ready again.
          if (!shipping.pushed) return { found: false, text: `GitHub has a release ${shipping.tag} that is not this work.` };
          return { found: "other", text: `GitHub has a release ${shipping.tag}, but its tag is not at the tested commit ${tested.slice(0, 7)}. Look at it on GitHub.` };
        }
        return { found: true, text: `release ${release.tag}`, record: () => this.recordRelease(task, release) };
      }
      const at = await git.revParse(product.path!, `refs/heads/${branch}`);
      if (at && (await git.contains(product.path!, at, tested))) return { found: true, text: `${branch} has the work (${tested.slice(0, 7)})`, record: (signal) => this.landLocal(task, signal, tested, "found") };
      return { found: false, text: `${branch} does not have the work yet.` };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { found: error instanceof Unreachable ? "unknown" : "other", text };
    }
  }

  private recordPr(task: MTask, pr: { number: number; url: string; state: "open" | "merged" | "closed" }, how?: "opened" | "updated"): "done" {
    task.pr = { number: pr.number, url: pr.url, state: pr.state, openedAt: task.pr?.openedAt ?? Date.now() };
    // GitHub answered: an open pull request now explains why the copy stays. Its earlier warning stays in history.
    if (pr.state === "open" && task.cleanup?.error === CLEANUP_WORDS.unconfirmed) delete task.cleanup;
    delete task.shipping;
    if (task.state === "cancelled") {
      this.k.log(task, "status", `Pull request #${pr.number} went out while you cancelled it: ${pr.url}`);
    } else {
      if (how) this.k.log(task, "done", how === "updated" ? `Updated PR #${pr.number}: ${task.report?.summary ?? "The checked work was added"}. Delivered to ${task.source!.destination.repo} · ${task.source!.destination.branch}` : `Petrina opened pull request #${pr.number}, and checked it on GitHub`);
      if (!task.repositories) this.k.tracking.delivered(task);
      endPetrinaStep(task, { outcome: how === "updated" ? `Updated pull request #${pr.number}` : how ? W.openedPr(pr.number) : W.alreadyOut(`pull request #${pr.number}`) }, Date.now());
      if (task.repositories) { this.k.saveRepository(task); this.saveOutcome(); return "done"; }
      if (pr.state === "open") {
        delete task.agent;
        task.holdsSlot = false;
        task.state = "pr-open";
        task.column = "ready";
        task.statusLine = how === "updated" ? `Updated PR #${pr.number}. Merge it on GitHub when you are happy` : `Pull request #${pr.number} is open. Merge it on GitHub when you are happy`;
      } else {
        this.finished(task, pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
      }
    }
    this.saveOutcome();
    return "done";
  }

  private recordRelease(task: MTask, release: { tag: string; url: string }, how?: "published"): "done" {
    task.release = release;
    delete task.shipping;
    if (task.state === "cancelled") this.k.log(task, "status", `Release ${release.tag} went out while you cancelled it: ${release.url}`);
    else {
      if (how) this.k.log(task, "done", `Petrina published release ${release.tag}, and checked it on GitHub`);
      if (!task.repositories) this.k.tracking.delivered(task);
      endPetrinaStep(task, { outcome: how ? W.released(release.tag) : W.alreadyOut(`release ${release.tag}`) }, Date.now());
      this.finished(task, `Released ${release.tag}`);
    }
    this.saveOutcome();
    return "done";
  }

  /** Whether GitHub already has this commit on the approved branch. Unknown when GitHub cannot be asked. */
  private async githubHas(task: MTask, branch: string, tested: string): Promise<boolean | "unknown"> {
    const product = this.k.repositoryOf(task)!;
    if (!product.remote || product.repo.startsWith("local/") || !git.sameRepo(product.remote, product.repo)) return false;
    let connection: Awaited<ReturnType<Connections["connection"]>>;
    try {
      connection = await this.connections.connection(task, new AbortController().signal);
    } catch {
      return "unknown";
    }
    if (!connection.ok) return connection.missing ? false : "unknown";
    try {
      const tip = await this.remoteTip(task, connection.remote, branch);
      return await this.remoteContains(task, connection.remote, branch, tip, tested);
    } catch {
      return "unknown";
    }
  }

  /**
   * A cancelled local move is recorded only after GitHub is asked. Seeing the commit on this computer
   * is not a completed push. An uncertain answer keeps the copy and does not claim the work was delivered.
   */
  private async noteCancelledLocal(task: MTask): Promise<boolean | "unknown"> {
    const product = this.k.repositoryOf(task)!;
    const branch = task.source?.destination.branch ?? product.defaultBranch ?? "main";
    const tested = task.shipping!.prepared!.tested;
    const reached = await this.githubHas(task, branch, tested);
    if (reached === "unknown") {
      if (task.localUpdate) task.localUpdate.pushed = false;
      this.k.commit();
      return "unknown";
    }
    const owes = Boolean(task.localUpdate) || Boolean(product.remote && !product.repo.startsWith("local/") && git.sameRepo(product.remote, product.repo));
    if (owes) task.localUpdate = { branch, sha: tested, pushed: reached };
    this.recordLanded(task, branch, tested, "found");
    return reached;
  }

  private recordLanded(task: MTask, branch: string, sha: string, how?: "found" | "moved"): "done" {
    task.landed = { branch, sha: sha.slice(0, 7) };
    // A local move is not a push. `localUpdate.pushed` is set only after GitHub is shown to have the commit.
    delete task.shipping;
    if (task.state === "cancelled") {
      this.k.log(task, "status", task.localUpdate && !task.localUpdate.pushed
        ? `${branch} moved forward in the local copy while you cancelled it (${sha.slice(0, 7)}). Its push to GitHub did not finish.`
        : `${branch} moved forward to it while you cancelled it (${sha.slice(0, 7)})`);
    }
    else {
      if (!task.repositories) this.k.tracking.delivered(task);
      if (how) this.k.log(task, "done", how === "found" ? `Checked: ${branch} already has it (${sha.slice(0, 7)})` : `Petrina moved ${branch} forward to it (${sha.slice(0, 7)}), and checked the main copy`);
      endPetrinaStep(task, { outcome: how === "moved" ? W.movedMain(branch) : W.alreadyOut(`${branch} has it`) }, Date.now());
      this.finished(task, `Committed to ${branch}`);
    }
    this.saveOutcome();
    return "done";
  }

  /** The verified delivery stays completed even when saving fails: removing its copy may free the disk. */
  private saveOutcome(): void {
    try {
      this.k.commitNow();
    } catch {
      this.k.commit();
    }
  }

  private finished(task: MTask, statusLine: string): void {
    if (task.repositories) { task.statusLine = statusLine; this.k.saveRepository(task); return; }
    delete task.agent;
    task.holdsSlot = false;
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = statusLine;
  }

  // ── Cancelled while publishing ─────────────────────────────────────────

  /**
   * A task cancelled during a publishing step: the same check as after any interruption looks up what went
   * out and keeps its link, and nothing more is published. The task stays cancelled. When GitHub cannot be
   * asked, Petrina asks again at the next check and after a restart, so nothing that went out stays hidden.
   * `fromDriver`: called as the task's own driver ends; otherwise it waits for a running driver to end.
   */
  async settleCancelled(taskId: Id, fromDriver = false): Promise<void> {
    const task = this.k.task(taskId);
    if (this.k.stopped || task?.state !== "cancelled" || !task.shipping?.step || !task.shipping.prepared || this.looking.has(taskId)) return;
    if (!fromDriver && (this.k.drivers.has(taskId) || this.k.settling.has(taskId))) return;
    this.looking.add(taskId);
    try {
      const delivery = await this.lookForDelivery(task);
      if (delivery.found === "unknown") return this.keepCancelledCopy(task);
      if (delivery.found === true) {
        if (task.delivery === "local" && task.source?.start.kind !== "pull-request") {
          // The branch may have moved on this computer. That is not a completed push, and cancelling does not send one.
          const reached = await this.noteCancelledLocal(task);
          if (reached === "unknown") return this.keepCancelledCopy(task);
        } else {
          await delivery.record(new AbortController().signal);
        }
      }
      else if (delivery.found === "other") this.k.log(task, "warn", `After you cancelled it, Petrina could not tell what went out: ${delivery.text}`);
      else if (task.source?.start.kind === "pull-request") {
        const start = task.source.start;
        task.pr = { number: start.number, url: start.url, state: "open", openedAt: task.pr?.openedAt ?? Date.now() };
        this.k.log(task, "status", `PR #${start.number} is still open. The checked work was not published: ${start.url}`);
      }
      else if (task.delivery === "release") await this.pushedWhileCancelled(task);
      // Looked up: what went out is recorded, and the delivery is over.
      delete task.shipping;
      this.k.commitNow();
    } catch (error) {
      if (error instanceof Unreachable) return this.keepCancelledCopy(task);
      this.k.log(task, "warn", `After you cancelled it, Petrina could not tell what went out: ${error instanceof Error ? error.message : String(error)}`);
      delete task.shipping;
      this.k.commitNow();
    } finally {
      this.looking.delete(taskId);
      this.k.tidy(taskId);
    }
  }

  /** Explain the retained copy once, including across retries and restarts, without an inbox item. */
  private keepCancelledCopy(task: MTask): void {
    if (task.cleanup?.error !== undefined) return;
    task.cleanup = { error: CLEANUP_WORDS.unconfirmed };
    this.k.log(task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmed));
    this.k.commit();
  }

  settleCancelledTasks(): void {
    for (const task of this.k.s.tasks) if (task.state === "cancelled" && task.shipping?.step) void this.k.trackWork(this.settleCancelled(task.id));
  }

  /** A cancelled release with no release on GitHub: say so when its push of the default branch and tag went out. */
  private async pushedWhileCancelled(task: MTask): Promise<void> {
    const shipping = task.shipping!;
    const { tested } = shipping.prepared!;
    const refs = await this.releaseRefs(task, this.connections.savedRemote(task));
    if (refs.tag === tested) this.k.log(task, "status", `${this.k.repositoryOf(task)?.defaultBranch ?? "main"} and the tag ${shipping.tag} went out to GitHub at ${tested.slice(0, 7)} while you cancelled it, with no release for that tag`);
  }

  // ── From before this version ───────────────────────────────────────────

  /**
   * Deliveries a Petrina from before it published deliveries saved while its delivery agent published them with a GitHub login:
   * Petrina cannot tell what went out, so it never acts on one by itself, and asks the coordinator instead.
   */
  carryOverShipping(): void {
    for (const task of this.k.s.tasks) {
      const saved = task.shipping as unknown as Record<string, unknown> | undefined;
      if (!saved || (typeof saved.moves === "number" && typeof saved.failures === "number")) continue;
      // Delivered already: nothing is left to decide.
      if (task.state === "done" || task.state === "pr-open") {
        delete task.shipping;
        continue;
      }
      task.shipping = { moves: 0, failures: 0, carriedOver: true };
      if (task.state === "cancelled") task.statusLine = `Cancelled. ${CARRIED_OVER}: check GitHub for what went out`;
      if (!["running", "waiting", "needs-you"].includes(task.state)) continue;
      // What the old version asked about this delivery goes: the coordinator's choice replaces it.
      this.k.s.inbox = this.k.s.inbox.filter((item) => item.taskId !== task.id);
      this.askCarriedOver(task);
    }
  }

  /**
   * A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator
   * checks GitHub and chooses: it went out (mark as done), or ship it again.
   */
  askCarriedOver(task: MTask): void {
    delete task.agent;
    delete task.conversation;
    task.holdsSlot = false;
    task.statusLine = `${CARRIED_OVER}: check GitHub, then choose`;
    if (!this.k.s.inbox.some((item) => item.taskId === task.id && item.kind === "shipping")) {
      // The step that was delivering ends as interrupted, and the task waits for the coordinator's choice.
      if (openStep(task)?.kind !== "you") endOpenStep(task, { outcome: W.interrupted, reason: W.shippingInterrupted, tone: "back" }, Date.now());
      beginYouStep(task, "shipping", Date.now());
      this.k.raise(task, "shipping", `Shipping “${task.title}” was interrupted`, false, {
        body: `${CARRIED_OVER}: check GitHub, then choose. Its delivery agent published deliveries itself then, so Petrina cannot tell what went out, and does nothing with it until you choose.`,
      });
      this.k.log(task, "warn", `${CARRIED_OVER}: check GitHub, then choose`);
    }
    task.state = "needs-you";
    this.k.commitNow();
  }

  // ── The coordinator's choices ──────────────────────────────────────────

  private takeShippingItem(itemId: Id): MTask | undefined {
    if (this.k.s.inbox.find((entry) => entry.id === itemId)?.kind !== "shipping") return undefined;
    const item = this.k.takeItem(itemId);
    return item && this.k.task(item.taskId);
  }

  /** "Check again": look for the interrupted delivery once more. */
  checkShipping(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    this.k.log(task, "you", "You asked Petrina to check again");
    endYouStep(task, { outcome: W.checkedAgain, reason: W.checkAgain }, Date.now());
    this.k.toWaiting(task);
    this.k.commit();
    this.k.schedule();
  }

  /**
   * "Ship it again": the delivery gets ready again, and Petrina publishes it after the same check as always. A
   * release whose push already went out keeps its version and commit. A delivery from before the update, which
   * the coordinator checked on GitHub, starts afresh from the delivery check, as the task sets it.
   */
  shipAgain(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    const shipping = task.shipping;
    if (shipping?.carriedOver) {
      delete task.shipping;
      this.clearApproval(task);
      const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
      if (check >= 0 && task.approveDelivery) {
        task.stageIndex = check;
        task.sub = 0;
      }
    } else if (shipping?.prepared && (shipping.localUpdated || task.source?.start.kind === "pull-request")) {
      // Keep the original tested commit until its publishing evidence is resolved.
    } else if (shipping && !shipping.pushed) {
      // What the work was stays, so an earlier version change can go before it gets ready again.
      task.shipping = { ...(shipping.start ? { start: shipping.start } : {}), moves: 0, failures: shipping.failures };
    }
    this.k.log(task, "you", "You asked to ship it again");
    endYouStep(task, { outcome: W.shippedAgain, reason: W.shipAgain }, Date.now());
    this.k.toWaiting(task);
    this.k.commitNow();
    this.k.schedule();
  }

  /** "Mark as done": it went out another way. */
  markDone(itemId: Id): void {
    const pending = this.k.s.inbox.find((item) => item.id === itemId);
    const shared = pending && this.k.task(pending.taskId);
    if (shared?.repositories && !shared.repositories.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) throw new Error("Check each unfinished delivery before marking this shared task as landed.");
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    if (task.repositories) {
      for (const work of task.repositories) if (work.pr?.state === "closed" && !work.landingAccepted) work.landingAccepted = { at: Date.now() };
      this.k.log(task, "you", "You resolved the closed pull requests. Open companion pull requests still need to land.");
      if (landingState(task.repositories) === "unfinished") { this.k.toWaiting(task); this.k.commitNow(); this.k.schedule(); }
      else this.finishMany(task);
      return;
    }
    if (!task.pr && (task.delivery === "pull-request" || task.shipping?.carriedOver)) {
      // An update's destination is the PR's working branch, not its base. Its existing approved-PR
      // path keeps the earlier cleanup rules; this extra attribution proof is for newly opened PRs.
      const tested = task.source?.start.kind === "pull-request" ? undefined : task.shipping?.prepared?.tested;
      const base = task.source?.destination.branch ?? this.k.repositoryOf(task)?.defaultBranch ?? "main";
      task.cleanup = { ...task.cleanup, pullRequest: "unconfirmed", ...(tested ? { checkedDelivery: { tested, base } } : {}) };
      if (!tested) delete task.cleanup.checkedDelivery;
    }
    delete task.shipping;
    this.k.clearStep(task);
    this.k.tracking.delivered(task);
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = "Marked as done by you";
    this.k.log(task, "you", "You marked it as done");
    endYouStep(task, { outcome: W.markedDone, reason: W.youMarkedDone }, Date.now());
    this.k.commitNow();
    this.k.schedule();
    void this.checkUnrecordedPullRequest(task);
    this.k.tidy(task.id);
  }

  /** An uncertain finished delivery: only GitHub can establish whether its copy is free, including after cancellation. */
  private async checkUnrecordedPullRequest(task: MTask): Promise<void> {
    const finished = () => task.state === "done" || task.state === "cancelled";
    if (this.k.stopped || !needsPullRequestCheck(task as Task) || !finished() || this.following.has(task.id)) return;
    this.following.add(task.id);
    try {
      const product = this.k.repositoryOf(task);
      // Older local deliveries may have published something themselves, but a computer-only product has no GitHub to ask.
      if (task.delivery === "local" && product?.repo.startsWith("local/")) {
        task.cleanup = { ...task.cleanup, pullRequest: "none" };
        if (task.cleanup.error === CLEANUP_WORDS.unconfirmedPr) delete task.cleanup.error;
        this.k.commit();
        return;
      }
      const repo = product?.repo;
      const result = repo && task.branch ? await git.pullRequests(repo, task.branch, this.k.options.gh) : undefined;
      if (this.k.stopped || !finished()) return;
      if (!result?.ok) {
        if (!task.cleanup?.error) this.k.log(task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmedPr));
        task.cleanup = { ...task.cleanup, error: CLEANUP_WORDS.unconfirmedPr };
      } else {
        const ours = result.value.filter((pr) => pr.head === task.branch && !pr.fork);
        const checked = task.cleanup?.checkedDelivery;
        let pr: git.PullRequestInfo | undefined;
        if (checked) {
          for (const candidate of ours) if (await this.matchesPullRequest(task, candidate, checked.tested, checked.base)) { pr = candidate; break; }
        } else {
          // Older deliveries did not record a checked commit. Keep their existing conservative
          // branch tracking so an open pull request can never lose its working copy.
          pr = ours.find((entry) => entry.state === "open") ?? ours.sort((a, b) => b.number - a.number)[0];
        }
        if (this.k.stopped || !finished()) return;
        const foreign = checked ? ours.find((entry) => entry.state === "open" && entry.number !== pr?.number) : undefined;
        const previousForeign = task.cleanup?.foreignPullRequest;
        task.cleanup = { ...task.cleanup, pullRequest: "none" };
        if (task.cleanup.error === CLEANUP_WORDS.unconfirmedPr) delete task.cleanup.error;
        if (foreign) {
          task.cleanup.foreignPullRequest = { number: foreign.number, url: foreign.url };
          if (previousForeign?.number !== foreign.number) this.k.log(task, "warn", `Pull request #${foreign.number} uses this branch but is not the checked work. Its working copy is kept until that pull request closes`);
        } else {
          delete task.cleanup.foreignPullRequest;
          if (previousForeign) this.k.log(task, "status", `The other pull request #${previousForeign.number} is no longer open on GitHub`);
        }
        if (pr) {
          task.pr = { number: pr.number, url: pr.url, state: pr.state, openedAt: Date.now() };
          this.k.log(task, "done", pr.state === "open" ? `Pull request #${pr.number} is still open on GitHub, so its working copy is kept` : pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
        }
      }
      this.k.commit();
    } catch {
      if (this.k.stopped || !finished()) return;
      if (!task.cleanup?.error) this.k.log(task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmedPr));
      task.cleanup = { ...task.cleanup, pullRequest: "unconfirmed", error: CLEANUP_WORDS.unconfirmedPr };
      this.k.commit();
    } finally {
      this.following.delete(task.id);
      this.k.tidy(task.id);
    }
  }

  /**
   * Petrina never merges or closes a pull request; it only reads what happened on GitHub. A cancelled task is
   * followed too while it keeps its working copy for an open pull request; it stays cancelled when that ends.
   * Unless GitHub confirms the pull request ended, it is still open, and the copy stays.
   */
  async pollPullRequests(): Promise<void> {
    for (const task of this.k.s.tasks.filter((entry) => entry.repositories)) {
      if (this.k.stopped || this.k.drivers.has(task.id) || this.following.has(task.id)) continue;
      this.following.add(task.id);
      try {
        this.k.saveRepository(task);
        for (const work of task.repositories!) if (work.pr?.state === "open") {
          const state = await git.prState(work.source!.product.repo, work.pr.number, this.k.options.gh).catch(() => undefined);
          if (state === "merged" || state === "closed") {
            work.pr.state = state;
            if (task.productId === work.productId && task.pr) task.pr.state = state;
            this.k.log(task, "done", `${work.source!.product.name}: ${state === "merged" ? "Pull request merged" : "Pull request closed without merging"}`);
          }
        }
        if ((task.state !== "cancelled" && task.repositories!.every(repositoryDelivered)) || task.repositories!.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) this.finishMany(task);
      } finally { this.following.delete(task.id); }
    }
    const following = (task: MTask) => task.pr?.state === "open" && !!task.worktree && (task.state === "pr-open" || ((task.state === "done" || task.state === "cancelled") && task.cleanup?.removedAt === undefined));
    await Promise.all([...this.k.s.tasks.filter((task) => !task.repositories && needsPullRequestCheck(task as Task)).map((task) => this.checkUnrecordedPullRequest(task)), ...this.k.s.tasks.filter((task) => !task.repositories && following(task)).map(async (task) => {
      if (this.k.stopped || this.following.has(task.id)) return;
      this.following.add(task.id);
      try {
        const repo = this.k.repositoryOf(task)?.repo;
        const state = repo ? await git.prState(repo, task.pr!.number, this.k.options.gh).catch(() => undefined) : undefined;
        if (this.k.stopped || (state !== "merged" && state !== "closed") || !following(task)) return;
        task.pr!.state = state;
        const words = state === "merged" ? `Merged #${task.pr!.number} on GitHub` : `Closed #${task.pr!.number} without merging`;
        if (task.state === "pr-open") {
          task.state = "done";
          task.column = "done";
          task.finishedAt = Date.now();
          task.statusLine = words;
          this.k.log(task, "done", words);
        } else {
          this.k.log(task, "done", words);
        }
        this.k.tracking.prSettled(task, state);
        this.k.commit();
        // Tasks waiting for this one to land can start now.
        this.k.schedule();
        this.k.tidy(task.id);
      } finally {
        this.following.delete(task.id);
      }
    })]);
  }
}
