import { describe, expect, it } from "vitest";
import { findingCount } from "../../../src/index.js";

describe("summaries start with a count", () => {
  it("counts what is left to fix, or says there is nothing", () => {
    expect(findingCount([])).toBe("Nothing to fix");
    expect(findingCount([{ severity: "blocking" }, { severity: "blocking" }, { severity: "suggestion" }])).toBe("2 important, 1 nit");
    expect(findingCount([{ severity: "suggestion" }, { severity: "suggestion" }])).toBe("2 nits");
    expect(findingCount([{ severity: "pre-existing" }])).toBe("Nothing to fix · 1 follow-up");
  });
});
