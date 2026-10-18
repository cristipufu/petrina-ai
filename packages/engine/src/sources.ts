import { deliveryLabel, workSummary, type TaskSource, type WorkChoice } from "@petrina/core";
import * as git from "./git.js";
import { background, branchExists, prNumber, sourcePr } from "./source-github.js";
import type { Kernel, MTask } from "./kernel.js";
import type { Connections } from "./connection.js";

export class Sources {
  constructor(private readonly k: Kernel, private readonly connections: Connections) {}

  async resolve(task: MTask, choice: WorkChoice): Promise<TaskSource> {
    const registered = this.k.s.products.find((entry) => entry.id === choice.productId);
    if (!registered) throw new Error(`Needs adding: ${choice.productId || "a product"}. Add it through Products, then choose it here, or replace it with a registered product.`);
    const product = task.workProduct?.id === choice.productId ? { ...task.workProduct, name: registered.name } : { id: registered.id, name: registered.name, repo: registered.repo, path: registered.path, remote: registered.remote, defaultBranch: registered.defaultBranch ?? "main" };
    const { startFrom, delivery } = choice;
    if (delivery === "release" && startFrom.kind !== "default") throw new Error("Releases start from the default branch. Correct the starting point or choose another delivery mode.");
    let start: TaskSource["start"];
    let repo = product.repo;
    let remote = product.remote;
    if (startFrom.kind === "pull-request") {
      const pr = await sourcePr(product.repo, prNumber(startFrom.value, product.repo), this.k.options.gh);
      if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. Choose an open pull request; the work stays here.`);
      start = { kind: "pull-request", number: pr.number, url: pr.url, headRepo: pr.headRepo, branch: pr.branch };
      repo = pr.headRepo;
      remote = repo.toLowerCase() === product.repo.toLowerCase() ? product.remote : `https://github.com/${repo}.git`;
    } else {
      const branch = startFrom.kind === "branch" ? startFrom.name : product.defaultBranch ?? "main";
      if (!git.isBranchName(branch) || (await git.run(["git", "check-ref-format", "--branch", branch], this.k.dataDir)).code) throw new Error("Enter an exact, valid branch name.");
      if (startFrom.kind === "branch") await branchExists(product.repo, branch, this.k.options.gh);
      start = { kind: startFrom.kind, branch };
    }
    return { product, start, destination: { mode: delivery, kind: start.kind === "pull-request" ? "update-pr" : delivery === "pull-request" ? "new-pr" : delivery === "release" ? "release" : "branch", repo, branch: start.branch, ...(remote ? { remote } : {}) }, confirmed: false };
  }

  async propose(task: MTask, proposal: readonly WorkChoice[] | undefined): Promise<void> {
    // Tasks saved before starting choices existed already chose this product and its default branch.
    if (!task.workChoice && task.productId) task.workChoice = { productId: task.productId, startFrom: { kind: "default" }, delivery: task.delivery };
    const choices = proposal ?? (task.workChoice ? [task.workChoice] : []);
    task.workProposal = [...choices];
    task.workError = "Checking the product and starting point with GitHub…";
    task.confirmWork = true;
    delete task.proposedSource;
    if (choices.length !== 1) {
      task.workError = choices.length > 1 ? "This plan involves several products. Choose one product for this task; multi-product tasks are a separate feature." : "Choose one registered product and its starting point.";
      task.confirmWork = true;
      return;
    }
    const choice = choices[0]!;
    try {
      const resolved = await this.resolve(task, choice);
      delete task.workError;
      const original = task.workChoice;
      // Compare resolved identities too: a PR number and its link are the same choice.
      let unchanged = original?.productId === choice.productId && original.delivery === choice.delivery && JSON.stringify(original.startFrom) === JSON.stringify(choice.startFrom);
      if (!unchanged && original?.productId === choice.productId && original.delivery === choice.delivery && original.startFrom.kind === "pull-request" && choice.startFrom.kind === "pull-request") {
        // A rejected old link must not prevent the coordinator from correcting it.
        try { unchanged = prNumber(original.startFrom.value, resolved.product.repo) === prNumber(choice.startFrom.value, resolved.product.repo); } catch { unchanged = false; }
      }
      if (task.source?.confirmed && (JSON.stringify(task.source.start) !== JSON.stringify(resolved.start) || JSON.stringify(task.source.destination) !== JSON.stringify(resolved.destination))) unchanged = false;
      if (unchanged && task.productId && (resolved.start.kind !== "pull-request" || task.source?.confirmed)) {
        task.source = { ...resolved, confirmed: true, ...(task.source?.initialSha ? { initialSha: task.source.initialSha } : {}) };
        task.confirmWork = false;
      } else {
        task.proposedSource = resolved;
        task.confirmWork = true;
      }
    } catch (error) {
      task.workError = error instanceof Error ? error.message : String(error);
      task.confirmWork = true;
    }
    const source = task.proposedSource ?? task.source;
    if (source) for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && stage.roleId === "release-manager") stage.title = deliveryLabel({ source, delivery: source.destination.mode });
    const item = this.k.s.inbox.find((entry) => entry.taskId === task.id && entry.kind === "plan");
    if (item) item.body = [task.proposedSource ?? task.source ? workSummary((task.proposedSource ?? task.source)!) : "", task.workError ?? ""].filter(Boolean).join("\n");
    this.k.commitNow();
  }

  confirm(task: MTask): void {
    // An older task may already have its working copy and an ordinary plan check.
    if (task.worktree && !task.source && !task.workProposal) return;
    if (task.workError || (!task.source && !task.proposedSource)) throw new Error(task.workError ?? "Choose a valid product and starting point first.");
    if (task.proposedSource) {
      if (task.worktree) throw new Error("This task already has a working copy. Keep its approved starting point, or start a new task for the new destination.");
      task.source = { ...task.proposedSource, confirmed: true };
      task.productId = task.source.product.id;
      task.delivery = task.source.destination.mode;
      task.workChoice = task.workProposal?.[0];
      task.workProduct = task.source.product;
      delete task.proposedSource;
    }
    task.confirmWork = false;
    this.k.log(task, "you", workSummary(task.source!));
  }

  async refresh(task: MTask): Promise<void> {
    if (task.source?.start.kind !== "pull-request") return;
    return this.connections.serial(task.productId, () => this.readBackground(task));
  }

  private async readBackground(task: MTask): Promise<void> {
    const source = task.source;
    if (source?.start.kind !== "pull-request") return;
    const pr = await sourcePr(source.product.repo, source.start.number, this.k.options.gh);
    if (pr.headRepo.toLowerCase() !== source.start.headRepo.toLowerCase() || pr.branch !== source.start.branch) throw new Error("The pull request's working repository or branch changed. Publishing is stopped; the approved destination stays unchanged.");
    if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. Publishing is stopped and the task's work is preserved.`);
    const text = await background(source.product.repo, pr, this.k.options.gh);
    task.prBackground = { readAt: Date.now(), head: pr.head, text };
    this.k.commitNow();
  }

  async fetch(task: MTask, signal: AbortSignal): Promise<{ sha: string; ref: string }> {
    const source = task.source!;
    const product = this.k.repositoryOf(task)!;
    const remote = await this.connections.requireConnection(task, signal);
    if (source.start.kind === "pull-request") await this.refresh(task);
    const ref = source.start.kind === "pull-request" ? `refs/petrina/sources/${task.id}` : `refs/remotes/origin/${source.start.branch}`;
    const from = source.start.kind === "pull-request" ? `refs/pull/${source.start.number}/head` : `refs/heads/${source.start.branch}`;
    // The last tip this task actually fetched. Read before the fetch replaces it.
    const remembered = await git.revParse(product.path!, ref);
    const result = await this.connections.serial(product.id, () => git.fetchRef(product.path!, remote, from, ref));
    if (!result.ok) throw new Error(`Could not fetch the approved starting point (${this.connections.why(task, result)}). Retry; no other branch or older copy was substituted.`);
    const replaced = "The starting branch's history was replaced or diverged. The task's work is preserved; it cannot be published safely without a decision.";
    if (source.initialSha && !(await git.contains(product.path!, result.sha, source.initialSha))) throw new Error(replaced);
    // A commit already brought in must still be in the new tip. A tip that is only behind commits on this
    // computer is not a rewrite: GitHub has not moved, and those commits were never on it. Dropping a tip
    // already fetched (a reset or a force-push) still stops, so a removed change is not put back.
    if (task.baseSha && task.baseSha !== result.sha && !(await git.contains(product.path!, result.sha, task.baseSha))) {
      const behindLocal = await git.contains(product.path!, task.baseSha, result.sha);
      const dropped = remembered !== undefined && remembered !== result.sha && !(await git.contains(product.path!, result.sha, remembered));
      if (!behindLocal || dropped) throw new Error(replaced);
    }
    return { sha: result.sha, ref };
  }
}
