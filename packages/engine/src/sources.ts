import { executionFor, resolveSource, SourceSelections, type RepositoryContext } from "@petrina/orchestrator";
import { productName, type TaskSource, type WorkChoice } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { background, sourcePr } from "@petrina/repositories/source-github";
import type { Kernel, MTask } from "./kernel.js";
import type { Connections } from "./connection.js";
import { sourceQueries } from "@petrina/repositories/source-queries";

import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";

export class Sources {
  private readonly backgroundReads = new WeakMap<RepositoryContext["work"], { source: string; at: number }>();
  private readonly selections: SourceSelections;
  private readonly queries;
  constructor(private readonly k: Kernel, private readonly connections: Connections) {
    this.queries = sourceQueries(k.dataDir, k.options.gh);
    this.selections = new SourceSelections({
      products: () => k.s.products,
      role: (id, task) => k.role(id, task),
      profileExists: id => !!k.profile(id),
      planCheck: taskId => k.s.inbox.find(item => item.taskId === taskId && item.kind === "plan"),
      commitNow: task => k.commitNow(task),
      recordChoice: (task, text) => k.log(task, "you", text),
    }, {
      resolve: (task, choice, candidate) => this.resolve(task, choice, candidate),
      repository: repo => this.queries.repository(repo),
      isAbsoluteFolder: isAbsolute,
    });
  }

  resolve(task: MTask, choice: WorkChoice, candidate?: TaskSource["product"]): Promise<TaskSource> {
    return resolveSource(executionFor(task), choice, this.k.s.products, this.queries, candidate);
  }

  propose(task: MTask, proposal: readonly WorkChoice[] | undefined, coordinator = false): Promise<void> {
    return this.selections.propose(task, proposal, coordinator);
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

  confirm(task: MTask): void { this.selections.confirm(task); }

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
