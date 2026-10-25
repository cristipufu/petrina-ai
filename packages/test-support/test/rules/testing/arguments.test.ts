import { expect, it } from "bun:test";
import { testSelection } from "../../../src/test-arguments.js";

it("recognizes explicit relative, absolute and native Windows paths while preserving bare name filters", () => {
  const paths = ["./test/a.test.ts", "../storage/test", "/private/cases/a.spec.ts", "C:\\cases\\a.test.ts", "\\\\server\\share\\tests", "./example.test.ts", "./a.test.mts", "./a.test.cts"];
  expect(testSelection([...paths, paths[0]!, "simple-name-filter", "example.test.ts", "a.test.mts"]).paths).toEqual(paths);
});

for (const option of ["-t", "--test-name-pattern", "--reporter-outfile", "--coverage-dir", "--preload", "-r", "--config", "--env-file", "--timings"]) it(`keeps the separate ${option} value out of selector validation`, () => {
  expect(testSelection([option, "not/a/test/path", "./test/real.test.ts"]).paths).toEqual(["./test/real.test.ts"]);
  expect(testSelection([`${option}=not/a/test/path`, "./test/real.test.ts"]).paths).toEqual(["./test/real.test.ts"]);
});

for (const option of ["--parallel", "--bail"]) it(`keeps ${option}'s optional count separate while retaining the next path`, () => {
  expect(testSelection([option, "./test"]).paths).toEqual(["./test"]);
  expect(testSelection([option, "14", "./test"]).paths).toEqual(["./test"]);
});

it("checks paths before and after options and stops interpreting options at the separator", () => {
  expect(testSelection(["./first.test.ts", "--watch", "--timeout=400", "../last.test.ts", "--", "./-literal.test.ts"]).paths)
    .toEqual(["./first.test.ts", "../last.test.ts", "./-literal.test.ts"]);
  expect(testSelection([])).toEqual({ paths: [] });
});

it("retains the final explicit working directory without mistaking pattern values for options", () => {
  expect(testSelection(["--cwd", "old", "--cwd=chosen", "./cases", "-t", "--cwd=pattern"]))
    .toEqual({ cwd: "chosen", paths: ["./cases"] });
  expect(testSelection(["--", "--cwd=literal", "./cases"])).toEqual({ paths: ["./cases"] });
});

it("does not treat runtime string values as test paths", () => {
  expect(testSelection(["--jsx-import-source", "@scope/runtime", "--redirect-warnings", "/new/warnings.log", "--user-agent", "tool/1.0", "./test"]))
    .toEqual({ paths: ["./test"] });
});

it("does not consume a path after a flag with an optional string value; its explicit equals value is unambiguous", () => {
  expect(testSelection(["--changed", "./missing.test.ts", "./valid.test.ts"]))
    .toEqual({ paths: ["./missing.test.ts", "./valid.test.ts"] });
  expect(testSelection(["--changed=feature/branch", "./valid.test.ts"])).toEqual({ paths: ["./valid.test.ts"] });
});
