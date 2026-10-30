import { expect, it } from "bun:test";
import { parseDiffPacket } from "../../../src/diff-format.js";

it("keeps literal binary and rename paths separate from displayed statistics and patch text", () => {
  const stat = " displayed | 2 +-\n 3 files changed\n", patch = "diff --git a/plain b/plain\n+literal\n";
  expect(parseDiffPacket(`1\t0\tplain\0-\t-\tline\n\tname\0` + `0\t0\t\0old\0new\0${stat}\0${patch}`))
    .toEqual({ paths: ["plain", "line\n\tname", "old", "new"], stat, patch });
  expect(parseDiffPacket("")).toEqual({ paths: [], stat: "", patch: "" });
  expect(parseDiffPacket("1\t1\tmodule\0 module | 2 +-\n\0Submodule module first..second:\n  > Nested commit\n").patch)
    .toBe("Submodule module first..second:\n  > Nested commit\n");
});

it("refuses truncated or malformed comparison records", () => {
  for (const text of ["1\t0\tplain", "1\t0\tplain\0", "0\t0\t\0old\0", "0\t0\t\0\0new\0", "stat\0diff --git a/a b/a\n",
    "1\t0\tplain\0unfinished stat\0"]) {
    expect(() => parseDiffPacket(text)).toThrow();
  }
});
