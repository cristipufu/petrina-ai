import { SourceBackground } from "@petrina/orchestrator";
import { executionFor, resolveSource, SourceSelections, type RepositoryContext } from "@petrina/orchestrator";
import { type TaskSource, type WorkChoice } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { background, sourcePr } from "@petrina/repositories/source-github";
import type { Kernel, MTask } from "./kernel.js";
import type { Connections } from "./connection.js";
import { sourceQueries } from "@petrina/repositories/source-queries";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";

export class Sources {
  private readonly sourceBackground: SourceBackground;
  private readonly selections: SourceSelections;
  private readonly queries;
  constructor(private readonly k: Kernel, private readonly connections: Connections) {
    this.sourceBackground = new SourceBackground({
      serial: (productId, read) => connections.serial(productId, read),
      readPullRequest: (repo, number) => sourcePr(repo, number, k.options.gh),
      background: (repo, pr) => background(repo, pr, k.options.gh),
      checkpoint: () => k.commitNow(), now: () => Date.now(),
    });
    this.queries = sourceQueries(k.dataDir, k.options.gh);
    this.selections = new SourceSelections({
      products: () => k.s.products,
      role: (id, task) => k.role(id, task),
      profileExists: id => !!k.profile(id), productId: () => k.id("product"), additionChanged: () => k.commitNow(),
      planCheck: taskId => k.s.inbox.find(item => item.taskId === taskId && item.kind === "plan"),
      commitNow: task => k.commitNow(task),
      recordChoice: (task, text) => k.log(task, "you", text),
    }, {
      resolve: (task, choice, candidate) => this.resolve(task, choice, candidate),
      repository: repo => this.queries.repository(repo),
      isAbsoluteFolder: isAbsolute, folderPath: resolve,
      folderOccupied: folder => readdir(folder).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }),
    });
  }

  resolve(task: MTask, choice: WorkChoice, candidate?: TaskSource["product"]): Promise<TaskSource> {
    return resolveSource(executionFor(task), choice, this.k.s.products, this.queries, candidate);
  }

  propose(task: MTask, proposal: readonly WorkChoice[] | undefined, coordinator = false): Promise<void> {
    return this.selections.propose(task, proposal, coordinator);
  }

  configureAddition(task: MTask, repo: string, name: string, path: string): Promise<void> {
    return this.selections.configureAddition(task, repo, name, path);
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

  refresh(scope: RepositoryContext, force = false): Promise<void> { return this.sourceBackground.refresh(scope, force); }

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
