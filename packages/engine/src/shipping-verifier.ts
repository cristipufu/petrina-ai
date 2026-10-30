// Observe exact approved delivery destinations. This module never publishes or records delivery.
import { realPath } from "@petrina/repositories/paths";
import * as github from "@petrina/repositories/github";
import * as git from "@petrina/repositories/git";
import { type Connections, Unreachable } from "./connection.js";
import type { Kernel } from "./kernel.js";
import type { RepositoryContext } from "@petrina/orchestrator";

type VerifierHost = Pick<Kernel, "repositoryOf" | "options" | "commit" | "github">;
import type { GitHubService, DeliveryLookup } from "@petrina/orchestrator";
export type { DeliveryEvidence, DeliveryLookup } from "@petrina/orchestrator";

export class ShippingVerifier {
  constructor(private readonly k: VerifierHost, private readonly connections: Connections) {}
  private checking(scope: RepositoryContext, status: string): void {
    if (scope.task.state === "cancelled") return;
    scope.task.statusLine = status;
    this.k.commit();
  }
  /** GitHub's listing for the task's branch: the pull request for this work, none, or a stop for anything else there. */
  async findPullRequest(scope: RepositoryContext, cancelled = false): Promise<github.PullRequestInfo | undefined> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const tested = repository.shipping!.prepared!.tested;
    const defaultBranch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    this.checking(scope, "Checking: looking for the pull request on GitHub");
    const listed = await this.connections.serial(product.id, () => this.k.github.pullRequests(product.repo, repository.branch!));
    if (!listed.ok) throw new Unreachable(`Petrina could not check GitHub for this task's pull request (${listed.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    const ours = listed.value.filter((pr) => pr.head === repository.branch && !pr.fork);
    // Cancellation publishes nothing more. Any open pull request from this branch needs its copy,
    // even when someone changed its base or added commits while the last publishing step was stopping.
    if (cancelled) return ours.find((pr) => pr.state === "open") ?? ours.find((pr) => pr.base === defaultBranch && pr.commit === tested);
    let match: github.PullRequestInfo | undefined;
    for (const pr of ours) {
      if (await this.matchesPullRequest(scope, pr, tested, defaultBranch)) {
        match = pr;
        break;
      }
    }
    const other = ours.find((pr) => pr !== match);
    if (other) {
      throw new Error(
        `GitHub already has pull request #${other.number} from this task's branch, but it is not this work (${other.base !== defaultBranch ? `it goes into ${other.base}` : `it is at ${other.commit.slice(
          0,
          7
        )}, not ${tested.slice(
          0,
          7
        )}`}). Petrina published nothing more. Look at it on GitHub, then retry or cancel.`,
      );
    }
    return match;
  }

  /** A reused branch name is not evidence of this delivery: its checked work and base must match. */
  async matchesPullRequest(scope: RepositoryContext, pr: github.PullRequestInfo, tested: string, base: string): Promise<boolean> {
    const { work: repository } = scope;
    if (pr.base !== base) return false;
    if (pr.commit === tested) return true;
    const remote = this.connections.savedRemote(scope);
    const tip = await this.remoteTip(scope, remote, repository.branch!);
    return tip === pr.commit && await this.remoteContains(scope, remote, repository.branch!, tip, tested);
  }

  /** Where the default branch and the release's tag are on GitHub, asked of GitHub itself. */
  async releaseRefs(scope: RepositoryContext, remote = this.connections.savedRemote(scope)): Promise<{ main?: string; tag?: string }> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    const tag = repository.shipping!.tag!;
    const refs = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`, `refs/tags/${tag}`]));
    if (!refs.ok) throw new Unreachable(`Petrina could not check ${branch} and the tag ${tag} on GitHub (${refs.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    const main = refs.value.get(`refs/heads/${branch}`);
    const at = refs.value.get(`refs/tags/${tag}^{}`) ?? refs.value.get(`refs/tags/${tag}`);
    return { ...(main ? { main } : {}), ...(at ? { tag: at } : {}) };
  }

  /** Is `sha` in the history of the default branch on GitHub, now at `at`? */
  async onGitHub(scope: RepositoryContext, remote: git.Remote, at: string | undefined, sha: string): Promise<boolean> {

    if (!at) return false;
    if (at === sha) return true;
    const product = this.k.repositoryOf(scope)!;
    const fetched = await this.connections.serial(product.id, () => git.fetchBranch(product.path!, remote, product.defaultBranch ?? "main"));
    if (!fetched.ok) throw new Unreachable(`Petrina could not check ${product.defaultBranch ?? "main"} on GitHub (${this.connections.why(
      scope,
      fetched
    )}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    return git.contains(product.path!, fetched.sha, sha);
  }

  async findRelease(scope: RepositoryContext): Promise<{ tag: string; url: string } | undefined> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const tag = repository.shipping!.tag!;
    this.checking(scope, `Checking: looking for the release ${tag} on GitHub`);
    const found = await this.connections.serial(product.id, () => this.k.github.findRelease(product.repo, tag));
    if (!found.ok) throw new Unreachable(`Petrina could not check GitHub for the release ${tag} (${found.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    if (found.value && (found.value.tag !== tag || found.value.draft)) throw new Error(`GitHub has a ${found.value.draft ? "draft " : ""}release for ${tag} that Petrina did not publish. Look at it on GitHub, then retry or cancel.`);
    return found.value ? { tag: found.value.tag, url: found.value.url } : undefined;
  }

  /** Checked in the main copy itself: the branch has the tested work, and its files match when it is checked out there. Returns where the branch is. */
  async verifyLocal(root: string, branch: string, tested: string): Promise<string> {
    const status = await git.worktreeBranchStatus(root, false).catch(() => undefined);
    if (status?.branch === branch) {
      const at = status.head;
      if (!at || (at !== tested && !(await git.contains(
        root,
        at,
        tested
      )))) throw new Error(`${branch} in the main copy does not have the tested work. Retry to check again.`);
      if (status.trackedChanged) throw new Error(`${branch} has the tested work, but the files in the main copy at ${root} do not match it. Look at the main copy.`);
      return at;
    }
    const at = await git.revParse(root, `refs/heads/${branch}`);
    if (!at || (at !== tested && !(await git.contains(
      root,
      at,
      tested
    )))) throw new Error(`${branch} in the main copy does not have the tested work. Retry to check again.`);
    if (!status) {
      const here = (await git.checkedOut(root, branch)).some((place) => realPath(place) === realPath(root));
      if (here && ((await git.head(root)) !== at || (await git.changes(
        root,
        true
      )).length)) throw new Error(`${branch} has the tested work, but the files in the main copy at ${root} do not match it. Look at the main copy.`);
    }
    return at;
  }

  destinationRemote(scope: RepositoryContext): git.Remote {
    const { work: repository } = scope;
    const source = repository.source!;
    const target = source.destination;
    if (!target.remote || !git.sameRepo(target.remote, target.repo)) throw new Error("The approved working repository has no usable saved GitHub address.");
    const local = this.k.options.sourceRemotes?.[target.repo] ?? (target.repo === source.product.repo ? this.k.options.remote : undefined);
    return local ? { url: local, local: true } : { url: target.remote };
  }

  async approvedPr(scope: RepositoryContext): Promise<Awaited<ReturnType<GitHubService["sourcePr"]>>> {
    const { work: repository } = scope;
    const source = repository.source!;
    if (source.start.kind !== "pull-request") throw new Error("No approved pull request.");
    const number = source.start.number;
    const pr = await this.connections.serial(repository.productId, () => this.k.github.sourcePr(source.product.repo, number));
    if (pr.headRepo.toLowerCase() !== source.start.headRepo.toLowerCase() || pr.branch !== source.start.branch) throw new Error("The pull request's working repository or branch changed. The work is preserved and its destination was not changed.");
    return pr;
  }

  /** A PR's existence alone proves nothing: its head must contain the exact tested commit. */
  async prContains(scope: RepositoryContext, pr: Awaited<ReturnType<GitHubService["sourcePr"]>>, tested: string): Promise<boolean> {
    const { task } = scope;
    if (pr.head === tested) return true;
    const product = this.k.repositoryOf(scope)!;
    const ref = `refs/petrina/evidence/${task.id}`;
    const result = await this.connections.serial(
      product.id,
      () => git.fetchRef(
      product.path!,
      this.connections.savedRemote(scope),
      `refs/pull/${pr.number}/head`,
      ref
    )
    );
    if (!result.ok) throw new Unreachable(`Could not confirm the tested work in PR #${pr.number}. Retry to check again; no further publishing will happen.`);
    if (result.sha !== pr.head) throw new Unreachable(`PR #${pr.number} changed while Petrina was checking it. Retry to confirm which work reached it.`);
    return git.contains(product.path!, result.sha, tested);
  }

  async remoteTip(scope: RepositoryContext, remote: git.Remote, branch: string): Promise<string | undefined> {

    const product = this.k.repositoryOf(scope)!;
    const result = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`]));
    if (!result.ok) throw new Unreachable(`Could not check the approved destination (${result.error}). No further publishing will happen until Retry confirms it.`);
    return result.value.get(`refs/heads/${branch}`);
  }

  async remoteContains(scope: RepositoryContext, remote: git.Remote, branch: string, tip: string | undefined, tested: string): Promise<boolean> {
    const { task, work: repository } = scope;
    if (!tip) return false;
    const root = this.k.repositoryOf(scope)!.path!;
    if (tip === tested) return true;
    if (tip === repository.shipping?.base) return false;
    const ref = `refs/petrina/deliveries/${task.id}`;
    const fetched = await this.connections.serial(repository.productId, () => git.fetchRef(root, remote, `refs/heads/${branch}`, ref));
    if (!fetched.ok) throw new Unreachable(`Could not confirm the tested work at its destination (${this.connections.why(
      scope,
      fetched
    )}). Retry to check again.`);
    return git.contains(root, fetched.sha, tested);
  }

  async sourceCurrent(scope: RepositoryContext, signal: AbortSignal): Promise<boolean> {
    const { work: repository } = scope;
    const connection = await this.connections.connection(scope, signal);
    if (!connection.ok) {
      if (connection.missing && repository.delivery === "local") return true;
      throw new Error(connection.reason);
    }
    const branch = repository.source?.start.branch ?? this.k.repositoryOf(scope)?.defaultBranch ?? "main";
    const tip = await this.remoteTip(scope, connection.remote, branch);
    if (!tip) throw new Error(`${branch} is no longer available on GitHub. The work is preserved and nothing more was published.`);
    // A local destination may be ahead of GitHub already.
    return tip === repository.shipping!.base || await git.contains(this.k.repositoryOf(scope)!.path!, repository.shipping!.base!, tip);
  }

  /**
   * Is the prepared delivery already out? Asked of GitHub for the product's own repository (never through a
   * working copy's remote), or of the main copy for local delivery. Only a clear "not there" counts as
   * nothing published; a lookup that fails is never taken for an empty answer.
   */
  async lookForDelivery(scope: RepositoryContext): Promise<DeliveryLookup> {
    const { task, work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const shipping = repository.shipping!;
    const { tested } = shipping.prepared!;
    const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    try {
      if (repository.source?.start.kind === "pull-request") {
        const pr = await this.approvedPr(scope);
        if (await this.prContains(scope, pr, tested)) return { found: true, text: `Updated PR #${pr.number}`, evidence: { kind: "pr", pr, updated: true } };
        const remote = this.destinationRemote(scope);
        const at = await this.remoteTip(scope, remote, pr.branch);
        if (await this.remoteContains(
          scope,
          remote,
          pr.branch,
          at,
          tested
        )) return {
          found: true,
          text: `Updated PR #${pr.number}`,
          evidence: {
          kind: "pr",
          pr,
          updated: true
        }
        };
        if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. The task's work is preserved; nothing more will be published.`);
        if (!at) throw new Error(`The approved pull request working branch is unavailable. The task's work is preserved.`);
        return { found: false, text: `PR #${pr.number} does not contain the tested work yet.` };
      }
      if (repository.delivery === "pull-request") {
        const pr = await this.findPullRequest(scope, task.state === "cancelled");
        if (pr) return { found: true, text: `pull request #${pr.number}`, evidence: { kind: "pr", pr } };
        return { found: false, text: "No pull request is open for this work yet." };
      }
      if (repository.delivery === "release") {
        const release = await this.findRelease(scope);
        if (!release) return { found: false, text: `There is no release ${shipping.tag} on GitHub yet.` };
        // Checked on GitHub itself: the release's tag is at the tested commit.
        const refs = await this.releaseRefs(scope, this.connections.savedRemote(scope));
        if (refs.tag !== tested) {
          // Before Petrina's push, someone else's release makes this version stale: publishing gets it ready again.
          if (!shipping.pushed) return { found: false, text: `GitHub has a release ${shipping.tag} that is not this work.` };
          return {
            found: "other",
            text: `GitHub has a release ${shipping.tag}, but its tag is not at the tested commit ${tested.slice(
            0,
            7
          )}. Look at it on GitHub.`
          };
        }
        return { found: true, text: `release ${release.tag}`, evidence: { kind: "release", release } };
      }
      const at = await git.revParse(product.path!, `refs/heads/${branch}`);
      if (at && (at === tested || (await git.contains(
        product.path!,
        at,
        tested
      )))) return {
        found: true,
        text: `${branch} has the work (${tested.slice(
        0,
        7
      )})`,
        evidence: {
        kind: "local",
        branch,
        tested
      }
      };
      return { found: false, text: `${branch} does not have the work yet.` };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { found: error instanceof Unreachable ? "unknown" : "other", text };
    }
  }

  /** Whether GitHub already has this commit on the approved branch. Unknown when GitHub cannot be asked. */
  async githubHas(scope: RepositoryContext, branch: string, tested: string): Promise<boolean | "unknown"> {

    const product = this.k.repositoryOf(scope)!;
    if (!product.remote || product.repo.startsWith("local/") || !git.sameRepo(product.remote, product.repo)) return false;
    let connection: Awaited<ReturnType<Connections["connection"]>>;
    try {
      connection = await this.connections.connection(scope, new AbortController().signal);
    } catch {
      return "unknown";
    }
    if (!connection.ok) return connection.missing ? false : "unknown";
    try {
      const tip = await this.remoteTip(scope, connection.remote, branch);
      return await this.remoteContains(scope, connection.remote, branch, tip, tested);
    } catch {
      return "unknown";
    }
  }
}
