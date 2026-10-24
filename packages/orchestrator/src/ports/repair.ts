import type { Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

/** Repair routing consumes only role lookup and one synchronous durable checkpoint. */
export interface RepairHost {
  role(id: string, task: RuntimeTask): Pick<Role, "result"> | undefined;
  /** Called after a pass is assigned, never for an ineligible/no-op decision. Failure propagates. */
  commitNow(task: RuntimeTask): void;
}
