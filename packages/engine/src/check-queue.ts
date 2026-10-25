import { CheckQueue as PortableCheckQueue } from "@petrina/orchestrator";
import { Aborted } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
export type { CheckPlace } from "@petrina/orchestrator";

/** Bind application error identities without coupling portable admission to the application. */
export class CheckQueue extends PortableCheckQueue {
  constructor(limit: () => number, closed: () => string | undefined, draining: () => boolean = () => false) {
    super(limit, closed, draining, { aborted: () => new Aborted(), unavailable: reason => new WaitingForUsage(reason) });
  }
}
