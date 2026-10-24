import { executionFor } from "@petrina/orchestrator";
import { detachRepositoryState, type RepositoryContext } from "@petrina/orchestrator";
import { productName, deliveryLabel, workSummary, type TaskSource, type WorkChoice } from "@petrina/core";
import * as github from "./github.js";
import * as git from "./git.js";
import { background, branchExists, prNumber, sourcePr } from "./source-github.js";
import type { Kernel, MTask } from "./kernel.js";
import type { Connections } from "./connection.js";

import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";

export class Sources {
  private readonly backgroundReads = new WeakMap<RepositoryContext["work"], { source: string; at: number }>();
  constructor(private readonly k: Kernel, private readonly connections: Connections) {}

  async resolve(task: MTask, choice: WorkChoice, candidate?: TaskSource["product"]): Promise<TaskSource> {
    const scope = executionFor(task);
    const row = task.workRows?.find((entry) => entry.choice === choice || (entry.choice.productId === choice.productId && entry.choice.repo === choice.repo));
    const addition = row?.addition;
    const registered = this.k.s.products.find((entry) => entry.id === choice.productId) ?? this.k.s.products.find((entry) => entry.repo.toLowerCase() === (choice.repo ?? choice.productId).toLowerCase())
      ?? (addition && row?.source ? { ...row.source.product, id: addition.productId, name: addition.name, path: addition.path } : candidate);
    if (!registered) throw new Error(`Needs adding: ${choice.productId || "a product"}. Add it through Products, then choose it here, or replace it with a registered product.`);
    const product = scope.work.workProduct?.id === choice.productId ? { ...scope.work.workProduct, name: registered.name } : { id: registered.id, name: registered.name, repo: registered.repo, path: registered.path, remote: registered.remote, defaultBranch: registered.defaultBranch ?? "main" };
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
      if ((startFrom.kind === "branch" || task.workRows) && !product.repo.startsWith("local/")) await branchExists(product.repo, branch, this.k.options.gh);
      start = { kind: startFrom.kind, branch };
    }
    return { product, start, destination: { mode: delivery, kind: start.kind === "pull-request" ? "update-pr" : delivery === "pull-request" ? "new-pr" : delivery === "release" ? "release" : "branch", repo, branch: start.branch, ...(remote ? { remote } : {}) }, confirmed: false };
  }

  async propose(task: MTask, proposal: readonly WorkChoice[] | undefined, coordinator = false): Promise<void> {
    const scope = executionFor(task);
    const selected = task.selectedProducts ?? (task.workChoice?.productId ? [task.workChoice] : []);
    if (task.workRows || (proposal && selected.some((choice) => !proposal.some((entry) => entry.productId === choice.productId))) || selected.length > 1 || (proposal?.length ?? 0) > 1 || proposal?.some((choice) => choice.repo && !this.k.s.products.some((product) => product.id === choice.productId || product.repo.toLowerCase() === choice.repo?.toLowerCase()))) {
      return this.proposeMany(task, proposal ?? selected, coordinator);
    }
    // Tasks saved before starting choices existed already chose this product and its default branch.
    if (!task.workChoice && task.productId) task.workChoice = { productId: task.productId, startFrom: { kind: "default" }, delivery: task.delivery };
    const choices = proposal ?? (task.workChoice ? [task.workChoice] : []);
    const pendingProposal = [...choices];
    task.workProposal = pendingProposal;
    task.workError = "Checking the product and starting point with GitHub…";
    task.confirmWork = true;
    delete task.proposedSource;
    if (choices.length !== 1) {
      task.workError = choices.length > 1 ? "This plan involves several products. Choose one product for this task; multi-product tasks are a separate feature." : "Choose one registered product and its starting point.";
      task.confirmWork = true;
      task.workValidating = false;
      this.k.commitNow(task);
      return;
    }
    const choice = choices[0]!;
    const current = () => task.workProposal === pendingProposal && !task.workRows;
    task.workValidating = true;
    try {
      this.k.commitNow(task);
      const resolved = await this.resolve(task, choice);
      if (!current()) return;
      delete task.workError;
      const original = task.workChoice;
      // Compare resolved identities too: a PR number and its link are the same choice.
      let unchanged = original?.productId === choice.productId && original.delivery === choice.delivery && JSON.stringify(original.startFrom) === JSON.stringify(choice.startFrom);
      if (!unchanged && original?.productId === choice.productId && original.delivery === choice.delivery && original.startFrom.kind === "pull-request" && choice.startFrom.kind === "pull-request") {
        // A rejected old link must not prevent the coordinator from correcting it.
        try { unchanged = prNumber(original.startFrom.value, resolved.product.repo) === prNumber(choice.startFrom.value, resolved.product.repo); } catch { unchanged = false; }
      }
      if (scope.work.source?.confirmed && (JSON.stringify(scope.work.source.start) !== JSON.stringify(resolved.start) || JSON.stringify(scope.work.source.destination) !== JSON.stringify(resolved.destination))) unchanged = false;
      if (unchanged && task.productId && (resolved.start.kind !== "pull-request" || scope.work.source?.confirmed)) {
        scope.work.source = { ...resolved, confirmed: true, ...(scope.work.source?.initialSha ? { initialSha: scope.work.source.initialSha } : {}) };
        task.confirmWork = false;
      } else {
        task.proposedSource = resolved;
        task.confirmWork = true;
      }
    } catch (error) {
      if (!current()) return;
      task.workError = error instanceof Error ? error.message : String(error);
      task.confirmWork = true;
    } finally {
      if (current()) task.workValidating = false;
    }
    const source = task.proposedSource ?? scope.work.source;
    if (source) for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && this.k.role(stage.roleId)?.result === "delivery") stage.title = deliveryLabel({ source, delivery: source.destination.mode });
    const item = this.k.s.inbox.find((entry) => entry.taskId === task.id && entry.kind === "plan");
    if (item) item.body = [task.proposedSource ?? scope.work.source ? workSummary((task.proposedSource ?? scope.work.source)!) : "", task.workError ?? ""].filter(Boolean).join("\n");
    this.k.commitNow();
  }

  private async proposeMany(task: MTask, proposal: readonly WorkChoice[], coordinator: boolean): Promise<void> {
    task.workValidating = true;
    task.workError = "Checking every product and starting point with GitHub…";
    this.k.commitNow();
    const prior = task.workRows;
    const selected = task.selectedProducts ?? [];
    const choices = proposal.map((choice) => {
      const product = this.k.s.products.find((entry) => entry.id === choice.productId) ?? this.k.s.products.find((entry) => entry.repo.toLowerCase() === (choice.repo ?? choice.productId).toLowerCase());
      return product ? { ...choice, productId: product.id, repo: product.repo } : choice;
    });
    if (!coordinator) for (const choice of selected) if (!choices.some((entry) => entry.productId === choice.productId)) choices.push(choice);
    task.workProposal = [...proposal];
    task.confirmWork = true;
    task.approvePlan = true;
    const rows = choices.map((raw) => {
      const product = this.k.s.products.find((entry) => entry.id === raw.productId || (raw.repo && entry.repo.toLowerCase() === raw.repo.toLowerCase()));
      const choice = { ...raw, ...(product ? { productId: product.id, repo: product.repo } : {}) };
      const earlier = selected.find((entry) => entry.productId === choice.productId);
      const saved = prior?.find((row) => row.choice.productId === choice.productId && row.choice.repo === choice.repo);
      const row: NonNullable<MTask["workRows"]>[number] = { choice, ...(saved?.addition ? { addition: saved.addition, source: saved.source } : {}) };
      if (!coordinator) {
        if (!proposal.some((entry) => entry.productId === choice.productId) && earlier) row.change = "omitted";
        else if (!earlier) row.change = "added";
        else if (JSON.stringify(earlier.startFrom) !== JSON.stringify(choice.startFrom) || earlier.delivery !== choice.delivery) { row.change = "changed"; row.previous = earlier; }
      }
      return { row, product, earlier };
    });
    const pendingRows = rows.map(({ row }) => row);
    task.workRows = pendingRows;
    await Promise.all(rows.map(async ({ row, product }) => {
      const { choice } = row;
      try {
        if (!product && !row.addition) {
          const repo = choice.repo ?? choice.productId;
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Needs adding: choose a registered product or an exact GitHub repository.");
          const read = await github.gh(this.k.options.gh ?? ["gh"], repo, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
          if (read.code) throw new Error(`Could not check ${repo} on GitHub. Retry when it is accessible.`);
          const data = JSON.parse(read.stdout);
          if (data.nameWithOwner?.toLowerCase() !== repo.toLowerCase() || !data.defaultBranchRef?.name) throw new Error(`GitHub did not confirm ${repo} and its default branch.`);
          if (task.workRows !== pendingRows) return;
          const candidate = { id: choice.productId || repo, name: repo.split("/")[1]!, repo, defaultBranch: data.defaultBranchRef.name, remote: `https://github.com/${repo}.git` };
          // Resolve branch and PR choices without cloning. A fork stays within this row.
          row.source = { product: candidate, start: { kind: "default", branch: candidate.defaultBranch }, destination: { mode: choice.delivery, kind: choice.delivery === "release" ? "release" : choice.delivery === "local" ? "branch" : "new-pr", repo, branch: candidate.defaultBranch, remote: candidate.remote }, confirmed: false };
          // Validation never creates an addition record: only the coordinator can confirm its folder.
          row.source = await this.resolve(task, choice, candidate);
          row.error = "Needs adding: confirm this product’s name and permanent folder.";
        } else row.source = await this.resolve(task, choice);
      } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
    }));
    // Apply cross-product decisions in the original order, after every independent read has finished.
    // A newer proposal owns its rows and validation flags; a late reply cannot replace them.
    if (task.workRows !== pendingRows) return;
    const seen = new Set<string>();
    for (const { row, product, earlier } of rows) {
      const { choice } = row;
      if (row.source) {
        const repo = row.source.product.repo.toLowerCase();
        if (seen.has(repo)) row.error = "This repository is already included. Leave out the duplicate.";
        seen.add(repo);
      }
      if (!earlier && (product?.approveDelivery !== false) && !task.approveDelivery) {
        task.approveDelivery = true;
        task.approvalExplanation = `${product?.name ?? row.source?.product.name ?? choice.productId} asks before shipping, so shared delivery approval is on. You can change it here.`;
      }
    }
    task.workValidating = false;
    task.workError = !task.workRows.length ? "Choose at least one product." : task.workRows.some((row) => row.error) ? task.workRows.filter((row) => row.error).map((row) => row.error).join("\n") : undefined;
    const item = this.k.s.inbox.find((entry) => entry.taskId === task.id && entry.kind === "plan");
    if (item) item.body = task.workRows.map((row) => [row.source ? workSummary(row.source) : row.choice.productId, row.choice.reason, row.error].filter(Boolean).join("\n")).join("\n\n");
    this.k.commitNow();
  }

  async configureAddition(task: MTask, repo: string, name: string, path: string): Promise<void> {
    const row = task.workRows?.find((entry) => entry.source?.product.repo.toLowerCase() === repo.toLowerCase());
    if (!row?.source || this.k.s.products.some((product) => product.repo.toLowerCase() === repo.toLowerCase())) throw new Error("Choose a repository that needs adding.");
    const displayName = productName(name, this.k.s.products);
    if (!isAbsolute(path)) throw new Error("Choose a full permanent folder path.");
    const folder = resolve(path);
    if (row.addition?.created && row.addition.path === folder) return;
    const occupied = await readdir(folder).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
    if (occupied) throw new Error("That folder already exists. Choose an unused folder; Petrina leaves existing folders untouched.");
    const id = row.addition?.productId ?? this.k.id("product");
    row.addition = { name: displayName, path: folder, productId: id };
    row.source.product = { ...row.source.product, id, name: displayName, path: folder };
    row.choice.productId = id;
    const work = task.repositories?.find((entry) => entry.productId === id);
    if (work && !work.worktree) {
      work.source = { ...row.source, confirmed: true };
      work.workProduct = work.source.product;
    }
    try { row.source = await this.resolve(task, row.choice); delete row.error; }
    catch (error) { row.error = error instanceof Error ? error.message : String(error); }
    task.workError = task.workRows!.some((entry) => entry.error) ? "Some product choices need your attention." : undefined;
    this.k.commitNow();
  }

  async addApproved(task: MTask, productId: string, signal: AbortSignal): Promise<void> {
    const row = task.workRows?.find((entry) => entry.source?.product.id === productId);
    const addition = row?.addition;
    if (!addition || addition.ready) return;
    if (!row.source?.confirmed && !task.repositories?.find((work) => work.productId === productId)?.source?.confirmed) throw new Error("Approve the complete plan before adding products.");
    task.statusLine = `Adding ${addition.name}…`;
    this.k.commitNow();
    if (!addition.created) {
      await mkdir(dirname(addition.path), { recursive: true });
      // Exclusive creation: an unrelated occupied folder is never retried or removed.
      await mkdir(addition.path);
      addition.created = true;
      this.k.commitNow();
    }
    if (signal.aborted) throw new Error("Adding this product was interrupted. The folder is saved for Retry.");
    const localRemote = this.k.options.remotes?.[row.source!.product.repo] ?? this.k.options.remote;
    const remote = localRemote ?? row.source!.product.remote!;
    const completeClone = async () => {
      const info = await git.repoInfo(addition.path).catch(() => undefined);
      if (!info || resolve(info.root) !== resolve(await realpath(addition.path))) return false;
      const matches = localRemote ? info.remote === localRemote : !!info.remote && git.sameRepo(info.remote, row.source!.product.repo);
      if (!matches) throw new Error(`${addition.name} couldn’t be added. Its saved folder belongs to a different repository. Change folder; Petrina leaves it untouched.`);
      const branch = row.source!.product.defaultBranch ?? "main";
      // A full clone can check out a newly chosen default; keep the approved branch.
      return !!(await git.revParse(addition.path, `refs/heads/${branch}`) ?? await git.revParse(addition.path, `refs/remotes/origin/${branch}`));
    };
    if (!await completeClone()) {
      const files = await readdir(addition.path);
      // Only the saved clone folder is resumable. Incomplete clone metadata can be replaced;
      // any user files keep the folder occupied and require a different destination.
      if (files.length && files.every((name) => name === ".git")) await rm(resolve(addition.path, ".git"), { recursive: true, force: true });
      else if (files.length) throw new Error(`${addition.name} couldn’t be added. Its interrupted folder is saved. Change folder if it contains unrelated files.`);
      const cloned = await git.run(["git", "clone", "--", remote, addition.path], this.k.dataDir, undefined, { credentials: true, local: !!(this.k.options.remote || this.k.options.remotes), timeoutMs: git.FETCH_TIMEOUT_MS });
      if (cloned.code) throw new Error(`${addition.name} couldn’t be added. Your plan and folder are saved. ${cloned.stderr}`);
      if (!await completeClone()) throw new Error(`${addition.name} couldn’t be added. The clone did not confirm the approved repository and default branch. Your plan and folder are saved.`);
    }
    const product = { ...row.source!.product, id: addition.productId, name: addition.name, path: await realpath(addition.path), tone: "blue" as const, delivery: row.choice.delivery, approveDelivery: true };
    if (!this.k.s.products.some((entry) => entry.id === product.id)) { this.k.s.products.push(product); this.k.tracking.product(product, { addedAt: Date.now() }); }
    addition.ready = true;
    this.k.commitNow();
  }

  confirm(task: MTask): void {
    const scope = executionFor(task);
    if (task.workValidating) throw new Error("Wait for every product choice to finish validation.");
    if (task.workRows) {
      const invalid = task.workRows.some((row) => {
        if (row.error || !row.source) return true;
        if (this.k.s.products.some((product) => product.id === row.source!.product.id)) return false;
        const addition = row.addition;
        return !addition?.name.trim() || !isAbsolute(addition.path) || addition.productId !== row.source.product.id || row.source.product.path !== addition.path;
      });
      if (!task.workRows.length || invalid) throw new Error("Correct every product and starting point, and confirm folders for additions before approval.");
      if (new Set(task.workRows.map((row) => row.source!.product.repo.toLowerCase())).size !== task.workRows.length) throw new Error("Choose each repository once.");

      const prepared = task.repositories;
      task.repositories = task.workRows.map((row) => {
        const prior = prepared?.find((work) => work.productId === row.source!.product.id && JSON.stringify(work.source?.start) === JSON.stringify(row.source!.start) && JSON.stringify(work.source?.destination) === JSON.stringify(row.source!.destination));
        return prior ?? ({ productId: row.source!.product.id, source: { ...row.source!, confirmed: true }, workProduct: row.source!.product, workChoice: row.choice, delivery: row.choice.delivery, completedStages: [], preparation: "waiting" }); });
      task.excludedRepositories = [...(task.excludedRepositories ?? []), ...(prepared ?? []).filter((work) => (work.worktree || work.preparingCopy) && !task.repositories!.some((kept) => kept.productId === work.productId))];
      if (task.plan) {
        const builder = task.plan.stages.find((stage) => this.k.role(stage.roleId)?.result === "build")?.profileIds[0];
        const reviewers = task.plan.stages.filter((stage) => stage.kind === "review-chain").flatMap((stage) => stage.profileIds);
        if (!builder || !reviewers.length) throw new Error("Every product needs a builder and review coverage.");
        task.plan.products = task.workRows.map((row) => ({ productId: row.source!.product.id, builderProfileId: row.choice.builderProfileId && this.k.profile(row.choice.builderProfileId) ? row.choice.builderProfileId : builder, reviewerProfileIds: reviewers }));
        task.plan.leadProductId = task.plan.products.some((work) => work.productId === task.plan!.leadProductId) ? task.plan.leadProductId : task.repositories[0]!.productId;
      }
      task.leadProductId = task.workRows.find((row) => row.choice.lead)?.source?.product.id ?? task.plan?.leadProductId ?? task.repositories[0]!.productId;
      if (task.plan) {
        task.plan.leadProductId = task.leadProductId;
        for (const stage of task.plan.stages) if (stage.kind === "do" && this.k.role(stage.roleId)?.result === "delivery") stage.title = task.repositories.length > 1 ? `Deliver across ${task.repositories.length} products` : deliveryLabel({ source: task.repositories[0]!.source, delivery: task.repositories[0]!.delivery });
      }
      task.productId = task.leadProductId;
      const lead = task.repositories.find((work) => work.productId === task.leadProductId)!;
      task.delivery = lead.delivery;
      task.workChoice = lead.workChoice;
      task.activeProductId = task.repositories[0]!.productId;
      detachRepositoryState(task);
      task.confirmWork = false;
      delete task.workError;
      this.k.log(task, "you", task.workRows.map((row) => workSummary(row.source!)).join("\n\n"));
      return;
    }
    // An older task may already have its working copy and an ordinary plan check.
    if (scope.work.worktree && !scope.work.source && !task.workProposal) return;
    if (task.workError || (!scope.work.source && !task.proposedSource)) throw new Error(task.workError ?? "Choose a valid product and starting point first.");
    if (task.proposedSource) {
      if (scope.work.worktree) throw new Error("This task already has a working copy. Keep its approved starting point, or start a new task for the new destination.");
      scope.work.source = { ...task.proposedSource, confirmed: true };
      scope.work.productId = scope.work.source.product.id;
      scope.work.delivery = scope.work.source.destination.mode;
      task.productId = scope.work.productId;
      task.delivery = scope.work.source.destination.mode;
      task.workChoice = task.workProposal?.[0];
      scope.work.workChoice = task.workChoice;
      scope.work.workProduct = scope.work.source.product;
      delete task.proposedSource;
    }
    task.confirmWork = false;
    this.k.log(task, "you", workSummary(scope.work.source!));
  }

  async refresh(scope: RepositoryContext, force = false): Promise<void> {
    const { task, work: repository } = scope;
    if (task.repositories && (repository.pr || repository.release || repository.landed)) return;
    if (repository.source?.start.kind !== "pull-request") return;
    return this.connections.serial(repository.productId, async () => {
      // Prompt background may be shared briefly; fetch/delivery identity checks bypass this cache.
      const cached = this.backgroundReads.get(repository);
      if (!force && cached?.source === JSON.stringify(repository.source) && Date.now() - cached.at < 15_000) return;
      await this.readBackground(scope);
    });
  }

  private async readBackground(scope: RepositoryContext): Promise<void> {
    const { work: repository } = scope;
    const source = repository.source;
    if (source?.start.kind !== "pull-request") return;
    const pr = await sourcePr(source.product.repo, source.start.number, this.k.options.gh);
    if (pr.headRepo.toLowerCase() !== source.start.headRepo.toLowerCase() || pr.branch !== source.start.branch) throw new Error("The pull request's working repository or branch changed. Publishing is stopped; the approved destination stays unchanged.");
    if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. Publishing is stopped and the task's work is preserved.`);
    const text = await background(source.product.repo, pr, this.k.options.gh);
    repository.prBackground = { readAt: Date.now(), head: pr.head, text };
    this.backgroundReads.set(repository, { source: JSON.stringify(source), at: repository.prBackground.readAt });
    this.k.commitNow();
  }

  async fetch(scope: RepositoryContext, signal: AbortSignal): Promise<{ sha: string; ref: string }> {
    const { task, work: repository } = scope;
    const source = repository.source!;
    const product = this.k.repositoryOf(scope)!;
    const remote = await this.connections.requireConnection(scope, signal);
    if (source.start.kind === "pull-request") await this.refresh(scope, true);
    const ref = source.start.kind === "pull-request" ? `refs/petrina/sources/${task.id}` : `refs/remotes/origin/${source.start.branch}`;
    const from = source.start.kind === "pull-request" ? `refs/pull/${source.start.number}/head` : `refs/heads/${source.start.branch}`;
    // The last tip this task actually fetched. Read before the fetch replaces it.
    const remembered = await git.revParse(product.path!, ref);
    const result = await this.connections.serial(product.id, () => git.fetchRef(product.path!, remote, from, ref));
    if (!result.ok) throw new Error(`Could not fetch the approved starting point (${this.connections.why(scope, result)}). Retry; no other branch or older copy was substituted.`);
    const replaced = "The starting branch's history was replaced or diverged. The task's work is preserved; it cannot be published safely without a decision.";
    if (source.initialSha && !(await git.contains(product.path!, result.sha, source.initialSha))) throw new Error(replaced);
    // A commit already brought in must still be in the new tip. A tip that is only behind commits on this
    // computer is not a rewrite: GitHub has not moved, and those commits were never on it. Dropping a tip
    // already fetched (a reset or a force-push) still stops, so a removed change is not put back.
    if (repository.baseSha && repository.baseSha !== result.sha && !(await git.contains(product.path!, result.sha, repository.baseSha))) {
      const behindLocal = await git.contains(product.path!, repository.baseSha, result.sha);
      const dropped = remembered !== undefined && remembered !== result.sha && !(await git.contains(product.path!, result.sha, remembered));
      if (!behindLocal || dropped) throw new Error(replaced);
    }
    return { sha: result.sha, ref };
  }
}
