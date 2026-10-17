// Delivering finished work (a pull request, a release or a local commit), and never shipping twice:
// shipping is noted before it starts, and an interrupted delivery is looked for before anything ships again.

import type { Id } from "@petrina/core";
import type { z } from "zod";
import * as git from "./git.js";
import { ShipResult } from "./prompts.js";
import { Kernel, Aborted, type MTask, SHIPPER_PROFILE } from "./kernel.js";

/** How far before shipping started a release still counts, for clocks that disagree. */
const CLOCK_SLACK_MS = 10 * 60_000;

type Delivery = { found: true; text: string; record: () => void } | { found: false; text: string };

export class Shipping {
  constructor(private readonly k: Kernel) {}

  async verifyDelivery(task: MTask, result: z.infer<typeof ShipResult>): Promise<void> {
    const product = this.k.productOf(task)!;
    const label = this.k.describe("shipper", SHIPPER_PROFILE);
    delete task.agent;
    task.holdsSlot = false;
    if (task.delivery === "pull-request") {
      const pr = await git.findPr(product.repo, task.branch!, this.k.options.gh);
      if (!pr) throw new Error("The shipper finished, but no pull request exists for this branch");
      this.recordPr(task, { ...pr, state: "open" });
      this.k.log(task, "done", `Opened pull request #${pr.number}`, "shipper", SHIPPER_PROFILE);
    } else if (task.delivery === "release") {
      const release = result.tag ? await git.findRelease(product.repo, result.tag, this.k.options.gh) : undefined;
      if (!release) throw new Error("The shipper finished, but the release could not be found on GitHub");
      this.recordRelease(task, release);
      this.k.log(task, "done", `Published release ${release.tag}`, "shipper", SHIPPER_PROFILE);
    } else {
      const sha = result.sha ?? (await git.head(task.worktree!));
      const branch = product.defaultBranch ?? "main";
      if (!(await git.landedOn(product.path!, branch, sha))) throw new Error(`The shipper finished, but the work is not on ${branch}`);
      this.recordLanded(task, branch, sha);
      this.k.log(task, "done", `Committed to ${branch} (${sha.slice(0, 7)})`, "shipper", SHIPPER_PROFILE);
    }
    delete task.shipping;
    this.k.finishStep(task);
    this.k.say(task, "agent", `${result.summary}\n\n${label}`, "shipper", SHIPPER_PROFILE);
    this.k.commitNow();
  }

  private recordPr(task: MTask, pr: { number: number; url: string; state: "open" | "merged" | "closed" }): void {
    task.pr = { number: pr.number, url: pr.url, state: pr.state === "merged" ? "merged" : "open", openedAt: Date.now() };
    if (pr.state === "open") {
      task.state = "pr-open";
      task.column = "ready";
      task.statusLine = `Pull request #${pr.number} is open. Merge it on GitHub when you are happy`;
    } else {
      this.finished(task, pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
    }
  }

  private recordRelease(task: MTask, release: { tag: string; url: string }): void {
    task.release = release;
    this.finished(task, `Released ${release.tag}`);
  }

  private recordLanded(task: MTask, branch: string, sha: string): void {
    task.landed = { branch, sha: sha.slice(0, 7) };
    this.finished(task, `Committed to ${branch}`);
  }

  private finished(task: MTask, statusLine: string): void {
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = statusLine;
  }

  /** On disk before the shipper gets any work: when it started, the latest release, and where main was. */
  async startShipping(task: MTask, signal: AbortSignal): Promise<void> {
    const product = this.k.productOf(task)!;
    const branch = product.defaultBranch ?? "main";
    const earlier = task.shipping;
    // A second attempt keeps what the first one found: the check covers everything since then.
    const [head, mainSha, originSha, latestRelease] = earlier
      ? [earlier.head, earlier.mainSha, earlier.originSha, earlier.latestRelease]
      : await Promise.all([
          git.head(task.worktree!).catch(() => undefined),
          git.revParse(product.path!, `refs/heads/${branch}`),
          git.revParse(task.worktree!, `refs/remotes/origin/${branch}`),
          task.delivery === "release" ? git.latestRelease(product.repo, this.k.options.gh) : undefined,
        ]);
    // Paused or stopped while Petrina looked: the shipper never got any work, so nothing was interrupted.
    if (signal.aborted) throw new Aborted();
    task.shipping = {
      startedAt: earlier?.startedAt ?? Date.now(),
      attempts: (earlier?.attempts ?? 0) + 1,
      boot: this.k.boot,
      ...(head ? { head } : {}),
      ...(mainSha ? { mainSha } : {}),
      ...(originSha ? { originSha } : {}),
      ...(latestRelease ? { latestRelease } : {}),
      ...(earlier?.found ? { found: earlier.found } : {}),
    };
    this.k.log(task, "status", earlier ? "Shipping again, finishing the interrupted attempt" : "Shipping started");
    this.k.commitNow();
  }

  /** After an interruption: record the delivery if it went out, or ask the coordinator. Never ship again on its own. */
  async checkDelivery(task: MTask, signal: AbortSignal): Promise<"stop"> {
    const shipping = task.shipping!;
    task.statusLine = "Checking whether it already went out";
    this.k.commit();
    const delivery = await this.lookForDelivery(task, shipping);
    if (signal.aborted) throw new Aborted();
    delete task.agent;
    task.holdsSlot = false;
    const when = shipping.boot === this.k.boot ? "" : " after a restart";
    if (delivery.found) {
      delivery.record();
      delete task.shipping;
      this.k.finishStep(task);
      this.k.log(task, "done", `Found${when} that it had already gone out: ${delivery.text}`, "shipper", SHIPPER_PROFILE);
      this.k.commitNow();
      return "stop";
    }
    shipping.found = delivery.text;
    task.statusLine = "Shipping was interrupted. Your call";
    this.k.raise(task, "shipping", `Shipping “${task.title}” was interrupted`, false, {
      body: `${delivery.text} Petrina will not ship it again on its own: check again, ship it again (the shipper finishes the interrupted attempt), or mark it as done if it went out another way.`,
    });
    this.k.log(task, "warn", `Shipping was interrupted${when}. ${delivery.text}`);
    this.k.commitNow();
    return "stop";
  }

  private async lookForDelivery(task: MTask, shipping: NonNullable<MTask["shipping"]>): Promise<Delivery> {
    const product = this.k.productOf(task)!;
    const branch = product.defaultBranch ?? "main";
    const worktree = task.worktree!;
    const head = shipping.head ?? (await git.head(worktree).catch(() => undefined));
    const unreachable: Delivery = { found: false, text: "Petrina could not reach GitHub to check whether it went out." };
    if (!head) return { found: false, text: "Petrina could not tell which work was being shipped." };
    // Asked of GitHub for the product's own repository, never through the working copy's remote.
    const { repo } = product;
    const gh = this.k.options.gh;

    if (task.delivery === "pull-request") {
      const pr = await git.prForBranch(repo, task.branch!, gh);
      if (!pr.ok) return unreachable;
      const found = pr.value;
      if (found) return { found: true, text: `pull request #${found.number}`, record: () => this.recordPr(task, found) };
      const pushed = await git.branchOnGitHub(repo, task.branch!, gh);
      if (!pushed.ok) return unreachable;
      return { found: false, text: pushed.value ? "The branch was pushed to GitHub, but no pull request was opened for it." : "No pull request was opened for this task's branch." };
    }

    if (task.delivery === "local") {
      // The shipper may have merged main into the branch first: its newer head counts too.
      const now = await git.head(worktree).catch(() => undefined);
      for (const sha of new Set([now ?? head, head])) {
        if (await git.landedOn(product.path!, branch, sha)) return { found: true, text: `the work is on ${branch} (${sha.slice(0, 7)})`, record: () => this.recordLanded(task, branch, sha) };
      }
      return { found: false, text: `The work is not on ${branch} yet.` };
    }

    const releases = await git.releasesSince(repo, shipping.startedAt - CLOCK_SLACK_MS, gh);
    if (!releases.ok) return unreachable;
    for (const tag of releases.value) {
      const contains = await git.onGitHub(repo, tag, head, gh);
      if (!contains.ok) return unreachable;
      if (!contains.value) continue;
      const release = await git.findRelease(repo, tag, gh);
      if (!release) return unreachable;
      return { found: true, text: `release ${tag}`, record: () => this.recordRelease(task, release) };
    }
    const pushed = await git.onGitHub(repo, branch, head, gh);
    if (!pushed.ok) return unreachable;
    return {
      found: false,
      text: pushed.value ? `The work (with any version change) was pushed to ${branch} on GitHub, but no release containing it was published.` : "No release containing this work was published since shipping started.",
    };
  }

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
    this.k.toWaiting(task);
    this.k.commit();
    this.k.schedule();
  }

  /** "Ship it again": the shipper finishes the interrupted attempt, told what Petrina found. */
  shipAgain(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    if (task.shipping) task.shipping.again = true;
    this.k.log(task, "you", "You asked to ship it again");
    this.k.toWaiting(task);
    this.k.commitNow();
    this.k.schedule();
  }

  /** "Mark as done": it went out another way. */
  markDone(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    delete task.shipping;
    this.k.finishStep(task);
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = "Marked as done by you";
    this.k.log(task, "you", "You marked it as done");
    this.k.commitNow();
    this.k.schedule();
  }

  async pollPullRequests(): Promise<void> {
    for (const task of this.k.s.tasks.filter((entry) => entry.state === "pr-open" && entry.pr && entry.worktree)) {
      const repo = this.k.productOf(task)?.repo;
      const state = repo ? await git.prState(repo, task.pr!.number, this.k.options.gh).catch(() => undefined) : undefined;
      if (state === "merged" || state === "closed") {
        task.pr!.state = state === "merged" ? "merged" : "open";
        task.state = "done";
        task.column = "done";
        task.finishedAt = Date.now();
        task.statusLine = state === "merged" ? `Merged #${task.pr!.number} on GitHub` : `Closed #${task.pr!.number} without merging`;
        this.k.log(task, "done", task.statusLine);
        this.k.commit();
        // Tasks waiting for this one to land can start now.
        this.k.schedule();
      }
    }
  }
}
