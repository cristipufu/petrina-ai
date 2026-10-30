import { openStep, runtimeWaitHolds, stepKey, type Id, type Role } from "@petrina/core";
import { executionFor, scopesFor, type RepositoryContext } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { ScreenGroup } from "./ports/screen.js";

export interface StepOwnershipHost {
  role(id: Id, task: RuntimeTask): Pick<Role, "result"> | undefined;
  group(taskId: Id): Pick<ScreenGroup, "recipients" | "running"> | undefined;
}

/** An admitted step owns its version until completion, including an editable attempt with partial work. */
export class StepOwnership {
  constructor(private readonly host: StepOwnershipHost) {}

  started(task: RuntimeTask): boolean {
    const step = openStep(task);
    const stage = task.plan?.stages[task.stageIndex];
    // A parallel seat is admitted before its copy is made; readiness placeholders do not qualify.
    const group = this.host.group(task.id);
    const reserved = group?.recipients().some(member => group.running(member));
    // Release notes never reopen; their interrupted history cannot defer their next preparation.
    const recorded = this.host.role(step?.roleId ?? "", task)?.result !== "delivery" && step?.kind === "agent"
      && step.stageId === stage?.id && step.round === (stage ? task.rounds[stage.id] ?? 1 : 1)
      && !!(step.agentInputs?.length || step.agentResults?.length);
    return !!task.driving || !!reserved || !!recorded || scopesFor(task).some(({ work }) => work.conversation?.step === stepKey(task) || work.editAttempt?.step === stepKey(task) && !work.editAttempt.failed)
      || !!task.hunt && Object.keys(task.hunt.reported).length > 0;
  }

  refreshDue(task: RuntimeTask): boolean {
    const wait = task.runtimeWait;
    if (!wait?.refreshPending || runtimeWaitHolds(task)) return false;
    if (wait.refreshAfterStep === stepKey(task) && this.started(task)) return false;
    // Failed attempts first get a clean-copy observation; dirty partial work still belongs to them.
    if (executionFor(task).work.editAttempt?.step === stepKey(task)) return false;
    const scopes = scopesFor(task);
    const delivered = (work: RepositoryContext["work"]) => !!task.repositories && !!(work.pr || work.release || work.landed);
    if (!scopes.length || scopes.some(({ work }) => !work.worktree && !delivered(work))) return false;
    return !wait.refreshProducts || !wait.refreshProducts.length || scopes.some(({ work }) => wait.refreshProducts!.includes(work.productId)
      && (delivered(work) || !(work.updating || work.shipping?.step || work.shipping?.pushed)));
  }

  admitEditable(scope: RepositoryContext, step: string): void { scope.work.editAttempt = { step }; }
  failed(scope: RepositoryContext): void {
    if (scope.work.editAttempt?.step === stepKey(scope.task)) scope.work.editAttempt.failed = true;
  }
}
