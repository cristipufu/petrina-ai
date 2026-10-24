import { expect, it } from "bun:test";
import { ReviewResult } from "../../../src/roles.js";

it("requires what a reviewer needs proved and why in structured proof proposals", () => {
  const item = { text: "Run Linux recovery", reason: "Final Linux proof is required", productIds: ["product"], checklistText: "Linux recovery works" };
  expect(ReviewResult.safeParse({ verdict: "pass", proofRequests: [{ ...item, reason: "" }] }).success).toBe(false);
  expect(ReviewResult.safeParse({ verdict: "pass", proofRequests: [{ ...item, text: "" }] }).success).toBe(false);
});
