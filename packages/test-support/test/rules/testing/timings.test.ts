import { expect, it } from "bun:test";
import { testTimingHints } from "../../../src/test-timings.js";

it("keeps measured durations only for currently discovered files without removing new files from the required manifest", () => {
  const expected = ["test/a.test.ts", "test/b.test.ts", "test/new.test.ts"];
  expect(testTimingHints(JSON.stringify({ version: 1, files: { "test/a.test.ts": 200, "test/b.test.ts": 0.5, "test/deleted.test.ts": 900 } }), expected))
    .toEqual({ version: 1, files: { "test/a.test.ts": 200, "test/b.test.ts": 0.5 } });
  expect(expected).toEqual(["test/a.test.ts", "test/b.test.ts", "test/new.test.ts"]);
});

it("recognizes native path separators while retaining Bun's own recorded spelling", () => {
  expect(testTimingHints(JSON.stringify({ version: 1, files: { ".\\test\\a.test.ts": 0 } }), ["test/a.test.ts"]))
    .toEqual({ version: 1, files: { ".\\test\\a.test.ts": 0 } });
});

for (const body of ["{", "null", "[]", '{"version":2,"files":{"test/a.test.ts":2}}', '{"version":1,"files":[]}', '{"version":1,"files":null}',
  '{"version":1,"files":{"test/a.test.ts":-1}}', '{"version":1,"files":{"test/a.test.ts":"2"}}', '{"version":1,"files":{"test/a.test.ts":1e400}}',
  '{"version":1,"files":{"test/old.test.ts":2}}', '{"version":1,"files":{"test/a.test.ts":2,"./test/a.test.ts":3}}'])
  it(`leaves invalid or inapplicable ordering hints unavailable: ${body}`, () => {
    expect(testTimingHints(body, ["test/a.test.ts"])).toBeUndefined();
  });
