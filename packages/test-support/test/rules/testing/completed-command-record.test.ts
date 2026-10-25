import { expect, it } from "bun:test";
import { completedCommandRecord } from "../../../src/completed-command-record.js";

const prefix = "OWNED_RESULT ";
const record = { entry: "observe", result: { ready: true } };
const line = prefix + JSON.stringify(record);

it("reads one framed JSON record only after a successful completed command", () => {
  expect(completedCommandRecord({ code: 0, stdout: `startup log\n${line}\ncompleted log\n` }, prefix)).toEqual(record);
  expect(completedCommandRecord({ code: 0, stdout: `${line}\r\n` }, prefix)).toEqual(record);
});

for (const code of [1, 143]) it(`rejects a plausible result followed by exit ${code}`, () => {
  expect(() => completedCommandRecord({ code, stdout: line + "\n" }, prefix)).toThrow(`The command exited with ${code}`);
});

for (const stdout of ["", "startup log\n", "another-prefix {}\n"]) it(`rejects missing framed output ${JSON.stringify(stdout)}`, () => {
  expect(() => completedCommandRecord({ code: 0, stdout }, prefix)).toThrow("exactly one completed result record");
});

it("rejects duplicate records instead of choosing a successful-looking one", () => {
  expect(() => completedCommandRecord({ code: 0, stdout: `${line}\n${prefix}{"entry":"different"}\n` }, prefix)).toThrow("exactly one completed result record");
});

it("rejects malformed JSON in the one framed record", () => {
  expect(() => completedCommandRecord({ code: 0, stdout: prefix + "{unfinished" }, prefix)).toThrow(SyntaxError);
});

it("rejects unretained output even if a caller supplied a plausible fragment", () => {
  expect(() => completedCommandRecord({ code: 0, stdout: line, outputRetained: false }, prefix)).toThrow("output was not retained");
});

it("requires an explicit nonempty frame", () => {
  expect(() => completedCommandRecord({ code: 0, stdout: "{}" }, "")).toThrow("nonempty record prefix");
});
