import { BUILT_IN_ROLES, roleForTask } from "@petrina/core";
import type { Id } from "@petrina/core";
import { DeliveryAdmission, type DeliveryAdmissionHost } from "../../src/delivery-admission.js";
import { scopesFor, type RepositoryWork } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import { repositoryTask } from "./tasks.js";

/** Only destination facts and live ownership: the actual controller owns every ordering decision. */
export function deliveryAdmissionFixture() {
  const tasks = new Map<Id, RuntimeTask>(), orders = new Map<Id, number>();
  const destinations = new WeakMap<RepositoryWork, { key: string; branch: string }>();
  const drivers = new Set<Id>(), settling = new Set<Id>();
  const state = { paused: false, draining: false, stopped: false, extraRecovery: false };
  let order = 0;
  const observation = (work: RepositoryWork) => {
    const seen = destinations.get(work);
    if (!seen) throw new Error("Unexpected unregistered destination observation");
    return seen;
  };
  const host: DeliveryAdmissionHost = {
    task: id => tasks.get(id), roleResult: (id, task) => roleForTask(BUILT_IN_ROLES, id, task)?.result,
    destination: scope => observation(scope.work).key, branch: scope => observation(scope.work).branch,
    reserveOrder: () => ++order, rememberOrder: (id, value) => { orders.set(id, value); }, forgetOrder: id => { orders.delete(id); }, hasOrder: id => orders.has(id),
    hasDriver: id => drivers.has(id), hasSettling: id => settling.has(id),
    taskAdmissionsClosed: () => state.paused || state.draining || state.stopped || state.extraRecovery,
    taskAdmissionWait: () => "Waiting for the pool to resume",
    admissionsClosed: () => state.paused || state.draining || state.stopped || state.extraRecovery,
    poolPaused: () => state.paused, draining: () => state.draining, stopped: () => state.stopped, extraRecovery: () => state.extraRecovery,
  };
  const admission = new DeliveryAdmission(host);
  const add = (id: string, products = ["a"], branch = "main") => {
    const task = repositoryTask(products.length > 1);
    task.id = id; task.title = id; task.state = "waiting"; task.stageIndex = 1;
    task.plan = { rationale: "Destination admission only", plannerProfileId: "sol-high", stages: [
      { id: "approval", kind: "gate", title: "Approve", gate: "delivery", roleId: "coordinator", profileIds: [] },
      { id: "ship", kind: "do", title: "Ship", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    if (task.repositories) task.repositories = products.map(productId => ({ productId, delivery: "local", completedStages: [] }));
    else task.repository = { productId: products[0]!, delivery: "local" };
    for (const { work } of scopesFor(task)) {
      work.source = { product: { id: work.productId, name: work.productId, path: `/private/${work.productId}`, repo: `local/${work.productId}`, defaultBranch: branch },
        start: { kind: "default", branch }, destination: { mode: "local", kind: "branch", repo: `local/${work.productId}`, branch }, confirmed: true };
      destinations.set(work, { key: `${work.productId}#${branch}`, branch });
    }
    tasks.set(id, task);
    return task;
  };
  return { tasks, orders, state, drivers, settling, host, admission, add };
}
