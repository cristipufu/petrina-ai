import type { DeliveryWorkflow } from "@petrina/orchestrator";
import type { Shipping } from "../../../src/shipping.js";

/** Compile-only contract: this function is never run or loaded by the test runner. */
export function deliveryWorkflowReceiver(workflow: DeliveryWorkflow, shipping: Shipping): void {
  workflow.deliver.bind(workflow);
  workflow["deliverOne"].bind(workflow);
  workflow["deliverMany"].bind(workflow);
  workflow.beforePublishing.bind(workflow);
  // @ts-expect-error Native Shipping is not the moved workflow's stateful receiver.
  workflow.deliver.bind(shipping);
  // @ts-expect-error Native Shipping is not the moved workflow's stateful receiver.
  workflow["deliverOne"].bind(shipping);
  // @ts-expect-error Native Shipping is not the moved workflow's stateful receiver.
  workflow["deliverMany"].bind(shipping);
  // @ts-expect-error Native Shipping is not the moved workflow's stateful receiver.
  workflow.beforePublishing.bind(shipping);
}
