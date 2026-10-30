// Local Git operations. Every command is an argument array: nothing goes through a shell.
//
// Agents can change a working copy's git settings (worktrees share them with the main clone), so
// Petrina's own git steps never run hooks or the file monitor, and only the steps that talk to
// GitHub (fetch, push, gh) get the coordinator's credentials. Those name the product's saved
// address, never a remote, and run only when the repository's settings pass the allowlist.
// Anything else a repository's settings start (filters, signing) runs with no credentials at all.
// Nothing here merges a pull request, force-pushes or deletes anything on GitHub.
//
// GitHub lookups are pinned to the product's repository and run outside any working copy, so an
// agent that rewrites a remote cannot change what Petrina reads.

export { githubRepoOf, githubRepo, sameRepo, isRefName, isRepoName, isBranchName, isSha } from "./identity.js";
export { copyFolderName } from "./copy-name.js";
export { EXIT_GRACE_MS } from "@petrina/platform/process-tree";
export {
  EXIT_UNREPORTED,
  OUTPUT_INCOMPLETE,
  OUTPUT_UNREADABLE,
  COMMIT_HOOKS,
  FETCH_TIMEOUT_MS,
  run,
  commandFailure,
} from "./git/exec.js";
export type {
  RunResult,
  StartFailure,
  Gh,
  Remote,
  Check,
  CommitHook,
  RunStart,
} from "./git/exec.js";
export {
  isSimpleValidBranchName,
  readLooseObjectPacket,
  readLooseObjectTypes,
  readFastLooseMergeBase,
  hasNoLooseLockfileChangesInRange,
  haveIdenticalLooseRange,
} from "./git/loose-objects.js";
export type {
  FileChange,
} from "./git/loose-objects.js";
export {
  fileAt,
  message,
  treeOf,
  plainFileAt,
  versionsBetween,
  head,
  currentBranch,
  revParse,
  contains,
  parents,
  checkedOut,
} from "./git/revisions.js";
export {
  remoteAddress,
  repoInfo,
  branchName,
  riskySettings,
  fetchBranch,
  fetchRef,
  remoteRefs,
  push,
} from "./git/remote.js";
export type {
  RepoInfo,
  Fetched,
} from "./git/remote.js";
export {
  ensureWorktree,
  isClean,
  readFastTrackedWorktreeHead,
  worktreeStatus,
  worktreeBranchStatus,
  changes,
  mergeInProgress,
  commitHooks,
  commitHookFiles,
  checkInputFiles,
  detachAt,
  reattach,
  trackedChanged,
  restoreTracked,
  moveTo,
  openOn,
  withMarkers,
  resetTo,
  linkedWorktrees,
  mainClone,
  removeWorktree,
  addCopy,
  removeFinishedCopies,
  removeCopies,
} from "./git/worktrees.js";
export {
  discardChanges,
  commitChanges,
  commitAll,
  commitVersion,
  contentTree,
  observeContentTree,
  squash,
  observeFold,
  withRootFile,
  commitTree,
  switchTo,
  fastForward,
  replaceLocalDelivery,
  createBranchAt,
} from "./git/commits.js";
export type {
  FoldObservation,
} from "./git/commits.js";
export {
  mergeBase,
  tryFastPlainReviewComparison,
  patchId,
  mergeTree,
  changedFiles,
  commitMessages,
  changedSince,
  trackedChangesSince,
  commitsSince,
  workingState,
  diffStat,
  tamperCheck,
} from "./git/diff-merge.js";
