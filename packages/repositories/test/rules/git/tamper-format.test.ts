import { expect, it } from "bun:test";
import { parseTamperPacket, tamperProblems } from "../../../src/tamper-format.js";

const record = (status: string, ...names: string[]) => `:100644 000000 abcdef0 0000000 ${status}\0${names.join("\0")}\0`;

it("keeps deleted binary and unusual names distinct from rename/copy paths and patch contents", () => {
  const patch = "diff --git a/changed.test.ts b/changed.test.ts\n+++ b/changed.test.ts\n+test.skip('first')\n+test.only('second')\n+binary\0content\n";
  const packet = parseTamperPacket(record("D", "tests/binary.dat") + record("D", "tests/line\n\tü.txt") + record("R100", "old.test.ts", "new.test.ts") + record("C99", "kept.test.ts", "copied.test.ts") + "\0" + patch);
  expect(packet).toEqual({ deleted: ["tests/binary.dat", "tests/line\n\tü.txt"], patch });
  expect(tamperProblems(packet.deleted, packet.patch)).toEqual([
    "A test file was deleted: tests/binary.dat", "A test file was deleted: tests/line\n\tü.txt", "A test was skipped or narrowed in changed.test.ts",
  ]);
  expect(parseTamperPacket("")).toEqual({ deleted: [], patch: "" });
});

it("retains the existing skip-marker, quoted-header and whole-output trimming behavior", () => {
  expect(tamperProblems(["  leading.test.ts", "ordinary.txt", "tests/trailing "], [
    "+++ b/plain.py", "+@Disabled", "+@Ignore", "+pytest.mark.skip", "+#[ignore]", "+xit('one')", "+xdescribe('two')", "+test.todo('three')",
    "+++ \"b/quoted\\tname.test.ts\"", "+it.only('four')", "-test.skip('removed')", " context test.skip('unchanged')",
  ].join("\n"))).toEqual(["A test file was deleted: leading.test.ts", "A test file was deleted: tests/trailing ", "A test was skipped or narrowed in plain.py"]);
  expect(tamperProblems([], "Submodule module first..second:\n  > New version\n")).toEqual([]);
});

it("rejects malformed or truncated raw framing without treating patch text as path records", () => {
  for (const text of [":100644", record("D", "lost.test.ts"), record("R100", "old"), record("C100", "old", ""), record("D", ""),
    record("D", "lost.test.ts").replace(":100644", ":10064ÿ"), "patch without raw framing\0"]) expect(() => parseTamperPacket(text)).toThrow();
});
