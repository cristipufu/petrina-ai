import { describe, expect, it } from "bun:test";
import { copyFolderName } from "../../../src/copy-name.js";

describe("Petrina's own git steps", () => {
  it("names review copy folders portably and distinctly, keeping ordinary members' names", () => {
    for (const member of ["review-0", "review-12", "vote-opus-high", "vote-sol-high", "vote-3f2a9c1e-7b4d-4e8a-9f00-1a2b3c4d5e6f"]) expect(copyFolderName(member)).toBe(member);
    expect(copyFolderName("vote-third:argon-high")).toBe("vote-third_3aargon-high");
    // Distinct places that naive punctuation replacement, a case-insensitive disk or Windows' rules would merge or refuse.
    const members = [
      "vote-third:argon-high", "vote-third-argon-high", "vote-third_argon-high", "vote-third.argon-high", "vote-third argon-high", "vote-third/argon-high", "vote-third\\argon-high",
      "vote-third_3aargon-high", "vote-Third:argon-high", "vote-third:Argon-high", "vote-third:argon-high.", "vote-third:argon-high ", "vote-thïrd:argon-high", "vote-third:argon-high\u{1F600}",
      "vote-\uD800", "vote-\uDBFF", "con", "CON", "Nul", "com1", "lpt9", "_63on", "_",
    ];
    const names = members.map(copyFolderName);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(members.length);
    const decode = (name: string) => name.replace(/_u([0-9a-f]{4})|_([0-9a-f]{2})/g, (_, wide?: string, narrow?: string) => String.fromCharCode(parseInt(wide ?? narrow!, 16)));
    for (const [index, name] of names.entries()) {
      // Only lowercase letters, digits, dashes and complete escapes: nothing Windows refuses or a disk folds together.
      expect(name).toMatch(/^(?:[a-z0-9-]|_[0-9a-f]{2}|_u[0-9a-f]{4})+$/);
      expect(name).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)$/);
      expect(decode(name)).toBe(members[index]!);
      expect(copyFolderName(members[index]!)).toBe(name);
    }
    expect(copyFolderName("")).toBe("_");
    expect(names).not.toContain("_");
  });
});
