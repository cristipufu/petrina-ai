// Pre-publication exact-candidate GitHub check validation for direct branch and release deliveries.
import { evaluateRemoteCheckGate, REMOTE_CHECK_LIMITS } from "@petrina/core";
import type { RepositoryContext } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { Unreachable } from "./connection.js";
import { Aborted } from "./kernel.js";
import type { ShippingPublishHooks } from "./shipping-publishers.js";

const DEFAULT_REMOTE_CHECK_POLL_MS = 5_000;
const DEFAULT_REMOTE_CHECK_TIMEOUT_MS = 20 * 60_000;

export { REMOTE_CHECK_LIMITS };

function sanitizeValidationSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "task";
}

export function candidateValidationBranch(taskId: string, sha: string, moves: number): string {
  const candidate = `petrina/validation/${sanitizeValidationSegment(taskId)}-${sha.slice(0, 12)}-${moves}`;
  return git.isBranchName(candidate) ? candidate : `petrina/validation/task-${sha.slice(0, 12)}-${moves}`;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Aborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function checkRemoteDestinationMovement(
  hooks: ShippingPublishHooks,
  scope: RepositoryContext,
  remote: git.Remote,
  branch: string,
  tested: string,
): Promise<"already-delivered" | "moved" | "current"> {
  const { k, verifier } = hooks;
  const product = k.repositoryOf(scope)!;
  const shipping = scope.work.shipping!;
  const tip = await verifier.remoteTip(scope, remote, branch);
  if (await verifier.remoteContains(scope, remote, branch, tip, tested)) {
    return "already-delivered";
  }
  if (!tip) {
    if (scope.work.source?.start.kind === "branch") {
      throw new Error(`${branch} is no longer available on GitHub. The checked work is preserved; nothing more was published.`);
    }
    return "current";
  }
  const base = shipping.base;
  if (base && tip !== base && !(await git.contains(product.path!, base, tip))) {
    if (scope.work.delivery === "release" || (await git.contains(product.path!, tip, base))) {
      return "moved";
    }
    throw new Error(
      `${branch} on GitHub has divergent history. The checked work is preserved; bring the destination copies into agreement before retrying.`,
    );
  }
  return "current";
}

export async function verifyRequiredRemoteChecks(
  hooks: ShippingPublishHooks,
  scope: RepositoryContext,
  signal: AbortSignal,
): Promise<"ready" | "again" | "continue" | "stop"> {
  const { k, connections } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const required = product.requiredRemoteChecks ?? [];
  if (!required.length) return "ready";
  if (repository.source?.start.kind === "pull-request" || repository.delivery === "pull-request") {
    return "ready";
  }
  if (product.repo.startsWith("local/")) {
    throw new Error(
      "GitHub checks are configured for this product, but it has no GitHub repository connected. Clear the GitHub checks or connect the repository before delivering.",
    );
  }
  if (repository.delivery === "local") {
    await hooks.needGitHub(scope.task);
  }

  const shipping = repository.shipping!;
  const tested = shipping.prepared!.tested;
  const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
  const remote = await connections.requireConnection(scope, signal);

  const initialMovement = await checkRemoteDestinationMovement(hooks, scope, remote, branch, tested);
  if (initialMovement === "already-delivered") return "ready";
  if (initialMovement === "moved") return hooks.prepareAgain(scope, `${branch} moved on GitHub`);

  if (shipping.remoteValidation?.sha === tested && shipping.remoteValidation.verifiedAt !== undefined) {
    return "ready";
  }

  const validationBranch = candidateValidationBranch(scope.task.id, tested, shipping.moves);
  const validationRef =
    shipping.remoteValidation?.sha === tested
      ? shipping.remoteValidation.ref
      : `refs/heads/${validationBranch}`;

  await connections.serial(product.id, async () => {
    if (signal.aborted) throw new Aborted();
    hooks.beforePublishing(scope);
    const existing = await git.remoteRefs(product.path!, remote, [validationRef]);
    if (!existing.ok) {
      throw new Unreachable(
        `Petrina could not check GitHub before validating checks (${existing.error}). Nothing was published. Retry when GitHub is reachable.`,
      );
    }
    if (existing.value.get(validationRef) === tested) {
      shipping.remoteValidation = { ref: validationRef, sha: tested, pushed: true };
      k.commitNow();
      return;
    }
    shipping.remoteValidation = { ref: validationRef, sha: tested };
    scope.task.statusLine = "Validating: pushing candidate for GitHub checks";
    k.commitNow();
    const pushed = await git.push(product.path!, remote, [{ sha: tested, ref: validationRef }]);
    if (!pushed.ok) {
      const after = await git.remoteRefs(product.path!, remote, [validationRef]);
      if (!after.ok || after.value.get(validationRef) !== tested) {
        throw new Error(
          `GitHub refused the candidate push for check validation (${pushed.error}), so Petrina published nothing. Retry once access is restored.`,
        );
      }
    }
    shipping.remoteValidation = { ref: validationRef, sha: tested, pushed: true };
    k.log(scope, "status", `Validating on GitHub: waiting for ${required.join(", ")}`);
    k.commitNow();
  });

  const pollMs = Math.max(5, k.options.remoteCheckPollMs ?? DEFAULT_REMOTE_CHECK_POLL_MS);
  const timeoutMs = Math.max(pollMs, k.options.remoteCheckTimeoutMs ?? DEFAULT_REMOTE_CHECK_TIMEOUT_MS);
  const startedAt = Date.now();

  while (true) {
    if (signal.aborted) throw new Aborted();
    hooks.beforePublishing(scope);
    const reply = await connections.serial(product.id, () => k.github.commitChecks(product.repo, tested));
    if (!reply.ok) {
      throw new Unreachable(
        `Petrina could not read GitHub checks (${reply.error}), so nothing was published. Retry when GitHub is reachable.`,
      );
    }
    const decision = evaluateRemoteCheckGate(required, reply.value);
    if (decision.kind === "failed") {
      return hooks.preparationFailed(scope, decision.summary, signal);
    }

    const movement = await checkRemoteDestinationMovement(hooks, scope, remote, branch, tested);
    if (movement === "already-delivered") return "ready";
    if (movement === "moved") return hooks.prepareAgain(scope, `${branch} moved on GitHub`);

    if (decision.kind === "passed") {
      shipping.remoteValidation = {
        ref: validationRef,
        sha: tested,
        pushed: true,
        verifiedAt: Date.now(),
      };
      k.log(scope, "done", `GitHub checks passed: ${required.join(", ")}`);
      k.commitNow();
      return "ready";
    }

    if (scope.task.state !== "cancelled") {
      scope.task.statusLine = decision.summary;
      k.commit();
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `${decision.summary} timed out before finishing on GitHub, so Petrina published nothing. Retry once the checks finish on GitHub.`,
      );
    }
    await abortableSleep(pollMs, signal);
  }
}
