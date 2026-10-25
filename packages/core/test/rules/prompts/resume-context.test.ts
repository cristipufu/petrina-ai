import { describe, expect, it } from "vitest";
import { formatWhereYouWere } from "../../../src/index.js";

describe.concurrent("where you were, for a fresh conversation", () => {
  it("lists up to 30 files and counts the rest", () => {
    const files = Array.from({ length: 34 }, (_, index) => ({ change: "changed", file: `src/file-${index + 1}.ts` }));
    const text = formatWhereYouWere({ stage: "Build", role: "Builder", done: ["Running the tests"], files }, "Codex cannot reopen conversations");
    expect(text).toContain("- changed: src/file-30.ts\n- and 4 more");
    expect(text).not.toContain("src/file-31.ts");
    expect(text).toContain("What you did last in this step, oldest first:\n- Running the tests");
  });
});
