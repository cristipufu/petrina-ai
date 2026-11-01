// Release versions and notes preparation. Publishing and its gates stay in Shipping.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as git from "@petrina/repositories/git";
import {
  declaredVersion,
  isVersionFile,
  lockWithVersion,
  MAIN_VERSION_FILES,
  nextVersion,
  onlyVersionChanged,
  ownCrates,
  parseVersion,
  withVersion
} from "./version.js";
import { type Kernel, type MutableStage, RELEASE_MANAGER_PROFILE } from "./kernel.js";
import type { RepositoryContext } from "@petrina/orchestrator";
import { type Connections, Unreachable } from "./connection.js";
import { ReleaseNotesResult } from "./roles.js";
import type { Turns } from "./turn.js";

type DeclaredVersion = { file: string; version?: string; text: string };
const MAX_LOG = 200;
function says(entries: readonly { file: string; version?: string }[]): string {
  return entries.map((entry) => `${entry.file} says ${entry.version ?? "something Petrina cannot read"}`).join(", ");
}
type ReleaseHost = Pick<Kernel, "repositoryOf" | "finishStep" | "commitNow" | "options" | "rememberVersion" | "github">;
export class ReleasePrep {
  constructor(private readonly k: ReleaseHost, private readonly turns: Turns, private readonly connections: Connections) {}

  /** Release previews contain text only; no version files change until shared approval. */
  async previewRelease(scope: RepositoryContext, stage: MutableStage, signal: AbortSignal): Promise<void> {
    const { task, work: repository } = scope;
    if (!task.repositories || repository.delivery !== "release") return;
    const start = await git.head(repository.worktree!);
    if (repository.releasePreview?.start === start && repository.releasePreview.base === repository.baseSha) return;
    repository.shipping = { moves: 0, failures: 0, start, base: repository.baseSha };
    try {
      await this.chooseVersion(scope, signal);
      const log = await this.sincePreviousRelease(scope, signal);
      const deliveryRoleId = stage.roleId || "release-manager";
      const result = await this.turns.turn(
        scope,
        deliveryRoleId,
        stage.profileIds[0] ?? RELEASE_MANAGER_PROFILE,
        () => [log],
        ReleaseNotesResult,
        signal,
        { initialHead: start }
      );
      const shipping = repository.shipping!;
      repository.releasePreview = {
        start,
        base: repository.baseSha,
        version: shipping.version!,
        tag: shipping.tag!,
        after: shipping.after!,
        notes: result.notes,
        summary: result.summary
      };
    } finally {
      delete repository.shipping;
    }
    this.k.finishStep(scope);
    this.k.commitNow();
  }

  /**
   * Every commit on the default branch since the previous release, up to this task's own, oldest first, with its
   * message: what the Release Manager writes the notes from. With no previous release (or none Petrina can find here),
   * the most recent ones, at most 200, saying so.
   */
  async sincePreviousRelease(scope: RepositoryContext, signal: AbortSignal): Promise<{ title: string; body: string }> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const shipping = repository.shipping!;
    const worktree = repository.worktree!;
    const branch = product.defaultBranch ?? "main";
    let from: string | undefined;
    if (shipping.after) {
      const remote = await this.connections.requireConnection(scope, signal);
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
    return {
      title,
      body: commits.map((commit) => `### ${commit.message.split("\n")[0]}\n${commit.message.split("\n").slice(1).join("\n").trim()}`.trim()).join("\n\n") || "(none)"
    };
  }

  /**
   * Petrina sets the release's version itself, in the product's main version files (and the product's own
   * entries in the Cargo.lock beside a Cargo.toml it changed), as one version commit on top of the work, and
   * checks it: only the version changed, and every main version file says it. Anything it cannot set or check
   * stops the release, with nothing published. Returns the commit to publish: the version commit, or the work
   * itself when its files already say the version (a first release, or none to set).
   */
  async setVersion(scope: RepositoryContext, declared: readonly DeclaredVersion[]): Promise<string> {
    const { work: repository } = scope;
    const worktree = repository.worktree!;
    const shipping = repository.shipping!;
    const start = shipping.start!;
    const version = shipping.version!;
    const stop = (why: string): never => {
      throw new Error(`Petrina could not set the version to ${version}: ${why}. It published nothing. Set it there yourself (only the version) in a task, or release by hand, then retry.`);
    };
    const due = declared.filter((entry) => entry.version !== version);
    if (!due.length) return start;
    const before = new Map<string, string>();
    const originals = new Map(declared.map(({ file, text }) => [file, text]));
    for (const { file, version: from, text } of due) {
      const next = withVersion(file, text, from!, version);
      if (next === undefined) return stop(`${file} does not state it in a way Petrina can change on its own`);
      before.set(file, from!);
      writeFileSync(join(worktree, file), next);
      // The product's own entries in the Cargo.lock beside it move with it.
      if (file.endsWith("Cargo.toml")) {
        const lockFile = join(dirname(file), "Cargo.lock").replace(/^\.\//, "");
        const lock = await git.fileAt(worktree, start, lockFile);
        if (lock !== undefined) {
          originals.set(lockFile, lock);
          const moved = lockWithVersion(lock, ownCrates(text), from!, version);
          if (moved !== lock) {
            before.set(lockFile, from!);
            writeFileSync(join(worktree, lockFile), moved);
          }
        }
      }
    }
    const conventional = /^[a-z]+(\([^)]+\))?!?: /.test(repository.report?.title ?? "");
    const message = `${conventional ? `chore(release): ${shipping.tag}` : `Release ${shipping.tag}`}\n\nSet the version to ${version}.\n\nBy Petrina`;
    if (!await git.commitChanges(worktree, message)) return start;
    const committed = await git.commitVersion(worktree);
    const tested = committed.head ?? await git.head(worktree);
    if (!tested) return start;
    // Checked like anyone's version commit: only the version, and every main version file says it.
    const changed = await git.changedFiles(worktree, start, tested);
    const targets = new Map<string, Promise<string | undefined>>();
    const targetAt = (file: string) => {
      let read = targets.get(file);
      if (!read) {
        read = existsSync(join(worktree, file)) ? git.fileAt(worktree, tested, file) : Promise.resolve(undefined);
        targets.set(file, read);
      }
      return read;
    };
    const [invalid, declaredAfter] = await Promise.all([
      Promise.all(changed.map(async (file) => {
        if (!isVersionFile(file)) return file;
        const [source, target] = await Promise.all([originals.has(file) ? originals.get(file) : git.fileAt(worktree, start, file), targetAt(file)]);
        return onlyVersionChanged(file, source, target, version, before.get(file)) ? undefined : file;
      })),
      this.declaredVersions(worktree, tested, targetAt),
    ]);
    const more = invalid.filter((file): file is string => file !== undefined);
    const wrong = declaredAfter.filter((entry) => entry.version !== version);
    if (more.length || wrong.length) {
      await git.resetTo(worktree, start);
      stop(more.length ? `the change in ${more.join(", ")} would be more than the version` : `${says(wrong)}`);
    }
    await this.k.rememberVersion(scope, committed.head === tested ? committed : undefined);
    return tested;
  }

  /** Releases: the latest published release plus the product's bump, worked out now, with its tag still free on GitHub. */
  async chooseVersion(scope: RepositoryContext, signal: AbortSignal): Promise<DeclaredVersion[]> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const shipping = repository.shipping!;
    const remote = await this.connections.requireConnection(scope, signal);
    const latest = await this.connections.serial(product.id, () => this.k.github.latestRelease(product.repo));
    if (!latest.ok) throw new Error(`Petrina could not read the latest release on GitHub (${latest.error}), so it published nothing. Retry when GitHub is reachable.`);
    // The product's main version files, on the work as it is now.
    const declared = await this.declaredVersions(repository.worktree!, shipping.start!);
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
    return declared;
  }

  /** What the product's main version files say at a commit: those that state a version, and those Petrina cannot read (no `version`). */
  private async declaredVersions(path: string, sha: string, read = (file: string) => existsSync(join(
    path,
    file
  )) ? git.fileAt(
    path,
    sha,
    file
  ) : Promise.resolve(undefined)): Promise<DeclaredVersion[]> {
    const contents = await Promise.all(MAIN_VERSION_FILES.map(read));
    return MAIN_VERSION_FILES.flatMap((file, index) => {
      const text = contents[index];
      if (text === undefined) return [];
      const declared = declaredVersion(file, text);
      return declared === "unreadable" ? [{ file, text }] : declared === "none" ? [] : [{ file, text, version: declared.version }];
    });
  }

  /** A release's version commit on top of `start`: one parent, and only version files changed. */
  async isVersionCommit(path: string, sha: string, start: string): Promise<boolean> {
    const parents = await git.parents(path, sha);
    if (parents.length !== 1 || parents[0] !== start) return false;
    const changed = await git.changedFiles(path, start, sha);
    return changed.length > 0 && changed.every(isVersionFile);
  }
}
