import { expect, it } from "bun:test";
import { restartPrompt, formatWhereYouWere } from "../../../src/prompts.js";
import { BuildResult, TestResult, ObjectionsResult, ReviewResult, NotesResult } from "../../../src/roles.js";

it("all five reporting roles allow optional pictures and require a caption on each one", () => {
  for (const [schema, base] of [
    [BuildResult, { summary: "Built it" }], [TestResult, { summary: "Checked it" }],
    [ObjectionsResult, {}], [ReviewResult, { verdict: "pass" }], [NotesResult, { summary: "Screens checked" }],
  ] as const) {
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, images: [{ path: "page.png", caption: "The checked page" }] }).success).toBe(true);
    for (const caption of [undefined, "", "   "]) expect(schema.safeParse({ ...base, images: [{ path: "page.png", caption }] }).success).toBe(false);
  }
});

it("both restart messages explain that pages and browser logins are gone", () => {
  const where = { stage: "Build", role: "Builder", done: [] };
  for (const text of [restartPrompt(where, { messages: [] }), formatWhereYouWere(where, "not found")]) {
    expect(text).toContain("Earlier pages and browser logins are gone");
  }
});
