import { DeliveryMonitor, type DeliveryRecorder } from "@petrina/orchestrator";
import type { Kernel } from "./kernel.js";
import type { ShippingVerifier } from "./shipping-verifier.js";
import { Unreachable } from "./connection.js";

/** Native composition for portable delivery observation and recovery decisions. */
export class PrMonitor extends DeliveryMonitor {
  constructor(k: Pick<Kernel, "task" | "stopped" | "drivers" | "settling" | "log" | "commitNow" | "commit" | "tidy" | "s" | "trackWork" | "repositoryOf" | "github" | "onTaskDone" | "tracking" | "schedule">, verifier: ShippingVerifier, delivery: DeliveryRecorder) {
    super({
      task: id => k.task(id), tasks: () => k.s.tasks, stopped: () => k.stopped,
      hasDriver: id => k.drivers.has(id), hasSettling: id => k.settling.has(id), now: () => Date.now(),
      log: (target, tone, text) => k.log(target, tone, text), commitNow: () => k.commitNow(), commit: () => k.commit(),
      tidy: id => k.tidy(id), trackWork: operation => k.trackWork(operation), repository: target => k.repositoryOf(target),
      done: task => k.onTaskDone?.(task), prSettled: (task, state) => k.tracking.prSettled(task, state), schedule: () => k.schedule(),
    }, {
      lookForDelivery: scope => verifier.lookForDelivery(scope), releaseRefs: scope => verifier.releaseRefs(scope),
      matchesPullRequest: (scope, pr, tested, base) => verifier.matchesPullRequest(scope, pr, tested, base),
      pullRequests: (repo, branch) => k.github.pullRequests(repo, branch), prState: (repo, number) => k.github.prState(repo, number),
      unreachable: error => error instanceof Unreachable,
    }, delivery);
  }
}
