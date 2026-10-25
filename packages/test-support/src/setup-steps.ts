import { SetupSteps } from "./setup-admission.js";

/** Leave a native poll between synchronous setup admissions. */
export function createSetupSteps(): SetupSteps {
  return new SetupSteps(work => { setTimeout(() => setImmediate(work), 0); });
}
