import { runtimeWaitHolds } from "@petrina/core";
import type { Id, Role } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { scopesFor, type RepositoryContext } from "./repository-context.js";
import { DeliveryTurns } from "./delivery-turns.js";

/** Native identities and live ownership are observations; destination ordering and invalidation live here. */
export interface DeliveryAdmissionHost {
  task(id: Id): RuntimeTask | undefined;
  roleResult(roleId: Id, task: RuntimeTask): Role["result"] | undefined;
  destination(scope: RepositoryContext): string;
  branch(scope: RepositoryContext): string;
  reserveOrder(): number;
  rememberOrder(taskId: Id, order: number): void;
  forgetOrder(taskId: Id): void;
  hasOrder(taskId: Id): boolean;
  hasDriver(taskId: Id): boolean;
  hasSettling(taskId: Id): boolean;
  taskAdmissionsClosed(task: RuntimeTask): boolean;
  taskAdmissionWait(task: RuntimeTask): string;
  admissionsClosed(): boolean;
  poolPaused(): boolean;
  draining(): boolean;
  stopped(): boolean;
  extraRecovery(): boolean;
}

export type PublishingAdmission = { kind: "ready" } | { kind: "wait"; reason: string } | { kind: "refresh" };

/** An ephemeral destination belongs to one live delivery step, never to a saved preparation. */
export class DeliveryAdmission {
  private readonly turns: DeliveryTurns;
  private readonly preparationEpochs = new WeakMap<RuntimeTask, number>();

  constructor(private readonly host: DeliveryAdmissionHost) {
    this.turns = new DeliveryTurns(() => this.host.reserveOrder());
  }

  entries(): readonly { taskId: Id; held: boolean }[] { return this.turns.entries(); }
  epoch(task: RuntimeTask): number { return this.preparationEpochs.get(task) ?? 0; }

  /** Ask before taking preparation room or an agent seat. A shared task owns every local branch at once. */
  waitingForTurn(task: RuntimeTask): string | undefined {
    const stage = task.plan?.stages[task.stageIndex];
    if (stage?.kind !== "do" || this.host.roleResult(stage.roleId, task) !== "delivery") {
      this.releaseDeliveryTurn(task.id);
      return undefined;
    }
    const local = scopesFor(task).filter(({ work }) => work.delivery === "local" && work.source?.destination.kind !== "update-pr");
    // Keep every originally requested branch until this shared delivery step ends, including owners already landed.
    const remembered = this.turns.destinationsFor(task.id);
    const keys = remembered ?? local.filter(({ work }) => !work.pr && !work.release && !work.landed && !work.nothingToPublish).map(scope => this.host.destination(scope));
    if (!keys.length) {
      this.releaseDeliveryTurn(task.id);
      return undefined;
    }
    // Turns are not saved. A restored candidate cannot keep a turn from the previous engine;
    // admitted publications still retain their exact candidate for the ordinary recovery lookup.
    if (!remembered) this.invalidateUnpublishedPreparations(task);
    const request = this.turns.request(task.id, keys);
    this.host.rememberOrder(task.id, request.order);
    if (!request.waitingFor) return undefined;
    const first = this.host.task(request.waitingFor);
    const blockedKeys = this.turns.destinationsFor(request.waitingFor);
    const blocked = local.find(scope => blockedKeys?.includes(this.host.destination(scope))) ?? local[0]!;
    const branch = this.host.branch(blocked);
    return `Waiting for “${first?.title ?? "another task"}” to finish delivering to ${branch}`;
  }

  releaseDeliveryTurn(taskId: Id): void {
    if (this.turns.entries().some(entry => entry.taskId === taskId && entry.held)) {
      const task = this.host.task(taskId);
      if (task) {
        this.invalidateUnpublishedPreparations(task);
        this.preparationEpochs.set(task, (this.preparationEpochs.get(task) ?? 0) + 1);
      }
    }
    this.turns.release(taskId);
    this.host.forgetOrder(taskId);
  }

  /** A candidate belongs to its destination turn; its start still restores an unpublished version commit. */
  invalidateUnpublishedPreparations(task: RuntimeTask): void {
    for (const { work } of scopesFor(task)) {
      if (work.pr || work.release || work.landed || work.nothingToPublish || work.shipping?.step || work.shipping?.pushed) continue;
      if (work.shipping) {
        delete work.shipping.prepared;
        delete work.shipping.remoteValidation;
      }
    }
  }

  /** An address confirmation may belong to a peer task; its callers yield without another Inbox item. */
  yieldForDecision(task: RuntimeTask): boolean {
    if (scopesFor(task).some(({ work }) => work.shipping?.step || work.shipping?.pushed)) return false;
    const released = this.turns.destinationsFor(task.id) !== undefined;
    this.releaseDeliveryTurn(task.id);
    return released;
  }

  /** A driver can yield before its delivery is admitted. That waiter keeps its original request order. */
  finishDeliveryTurn(taskId: Id): void {
    const task = this.host.task(taskId);
    const stage = task?.plan?.stages[task.stageIndex];
    const waiting = this.turns.entries().some(entry => entry.taskId === taskId && !entry.held);
    if (waiting && task?.state === "waiting" && !task.held && !this.host.taskAdmissionsClosed(task)
      && stage?.kind === "do" && this.host.roleResult(stage.roleId, task) === "delivery") return;
    this.releaseDeliveryTurn(taskId);
  }

  /** Waiters are ordinary scheduler entries. Only a live holder can retain its check-line place over a pause. */
  syncDeliveryTurns(): void {
    for (const { taskId, held } of this.turns.entries()) {
      const task = this.host.task(taskId);
      const stage = task?.plan?.stages[task.stageIndex];
      const live = this.host.hasDriver(taskId) || this.host.hasSettling(taskId);
      const publishing = task && scopesFor(task).some(({ work }) => work.shipping?.step);
      // An admitted publication still settles after cancellation or a hold. Its driver gives up ownership last.
      // A Release Manager's question yields its destinations; beforePublishing asks for them again afterwards.
      if (held && live && (task?.state !== "needs-you" || publishing)) continue;
      if (!task || !["running", "waiting"].includes(task.state) || task.held || runtimeWaitHolds(task)
        || stage?.kind !== "do" || this.host.roleResult(stage.roleId, task) !== "delivery"
        || this.host.admissionsClosed() && (!held || !this.host.hasDriver(taskId))) this.releaseDeliveryTurn(taskId);
    }
  }

  /** Check again at the actual publication admission, including after preparation and a product queue. */
  beforePublishing(scope: RepositoryContext, queuedCheck = false): PublishingAdmission {
    const { task, work } = scope;
    if (work.shipping?.step || work.shipping?.pushed) return { kind: "ready" };
    const localTurn = scopesFor(task).some(({ work }) => work.delivery === "local" && work.source?.destination.kind !== "update-pr" && !work.pr && !work.release && !work.landed && !work.nothingToPublish);
    const keepsPausedPlace = queuedCheck && this.host.poolPaused() && !this.host.draining() && !this.host.stopped() && !this.host.extraRecovery() && !runtimeWaitHolds(task)
      && (!localTurn || this.host.hasOrder(task.id));
    if (this.host.taskAdmissionsClosed(task) && !keepsPausedPlace) {
      const words = this.host.taskAdmissionWait(task);
      return { kind: "wait", reason: !runtimeWaitHolds(task) && !this.host.draining() ? `${words} before publishing` : words };
    }
    const deliveryWait = this.waitingForTurn(task);
    if (deliveryWait) return { kind: "wait", reason: deliveryWait };
    const wait = task.runtimeWait;
    if (wait?.refreshPending && (!wait.refreshProducts || wait.refreshProducts.includes(work.productId))) return { kind: "refresh" };
    return { kind: "ready" };
  }
}
