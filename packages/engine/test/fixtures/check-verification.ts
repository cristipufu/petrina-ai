import { checkOutcome } from "@petrina/core";
import type { CheckVerification } from "../../src/product-checks.js";

/** Raw command-count diagnostic only. Routing must inspect the explicit verification kind. */
export const nonpassingChecks = (result: CheckVerification): number => result.results.filter(run => checkOutcome(run).kind !== "passed").length;
