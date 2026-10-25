import { expect, it } from "bun:test";
import { quoteGitShellWord } from "../../../src/git-shell-word.js";

it("quotes Git-shell words literally, including empty words, apostrophes and command characters", () => {
  const cases = [
    ["plain", "'plain'"],
    ["two words", "'two words'"],
    ["", "''"],
    ["a'b", "'a'\\''b'"],
    ["$HOME;$(program)", "'$HOME;$(program)'"],
    ["C:\\private folder\\file", "'C:\\private folder\\file'"],
    ["line\nnext", "'line\nnext'"],
  ] as const;
  for (const [word, expected] of cases) expect(quoteGitShellWord(word)).toBe(expected);
});
