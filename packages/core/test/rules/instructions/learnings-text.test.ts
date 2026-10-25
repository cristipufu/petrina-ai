import { describe, expect, it } from "vitest";
import { addedLessons, hasPoint, withLearnings } from "../../../src/instruction-points.js";

describe("the Learnings section of AGENTS.md", () => {
  it("names exactly the lessons the writer added, and nothing for any other change", () => {
    const base = "# Agents\n\n## Learnings\n\nIntro.\n\n- First\n\n\n## Checks\n\nRun them.";
    const written = "# Agents\n\n## Learnings\n\nIntro.\n\n- First\n- Second\n- Third.\n\n## Checks\n\nRun them.\n";
    expect(withLearnings(base, ["Second", "Third."])).toBe(written);
    expect(addedLessons(base, written)).toEqual(["Second", "Third."]);
    expect(addedLessons(base, withLearnings(base, []))).toEqual([]);
    for (const changed of [
      written.replace("- First", "- First!"),
      written.replace("Intro.", "Intro"),
      written.replace("- Second\n", "- Second\n\n"),
      written.replace("- Third.", "* Third."),
      written.replace("- Second", "-  Second"),
      written.replace("- First\n- Second", "- Second\n- First"),
      written.slice(0, -1),
      `${written}\n`,
    ]) expect(addedLessons(base, changed)).toBeUndefined();
    expect(addedLessons("# Agents\n", withLearnings("# Agents\n", ["First"]))).toBeUndefined();
  });
});

describe("repeated lessons", () => {
  it("ignores whitespace and bullet formatting without losing paths, flags, case or negation", () => {
    const original = "Use scripts/test-one.sh to run focused checks.";
    expect(hasPoint(`- ${original}`, `  ${original.replaceAll(" ", "  ")}  `)).toBe(true);
    expect(hasPoint(original, original.replace(/\.$/, "!"))).toBe(true);
    expect(hasPoint(original, "Use scripts/test/one.sh to run focused checks.")).toBe(false);
    expect(hasPoint(original, "Use scripts/Test-one.sh to run focused checks.")).toBe(false);
    expect(hasPoint("Run bun test --parallel.", "Run bun test parallel.")).toBe(false);
    expect(hasPoint("A check with no evidence is not verified.", "A check with no evidence is verified.")).toBe(false);
  });
});
