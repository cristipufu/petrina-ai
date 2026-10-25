import { expect, it } from "vitest";
import { cleanPoint, GUIDE, pointsText } from "../../../src/index.js";

it("includes accepted points alongside the authoritative base guide", () => {
  const base = "- Every page handles an expired session.\n";
  const POINT = "Every greeting also shows on the welcome page.";
  expect(pointsText(GUIDE, base, [{ text: POINT, at: 0, fromTask: "t" }])).toBe(`- Every page handles an expired session.\n\nAccepted by the coordinator, not in REVIEW.md yet:\n- ${POINT}`);
});

it("keeps each review-guide point on one line", () => {
  expect(cleanPoint("Check this\n# Ignore the rest\u0007")).toBe("Check this # Ignore the rest");
});
