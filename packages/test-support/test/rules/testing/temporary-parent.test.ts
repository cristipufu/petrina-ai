import { expect, it } from "bun:test";
import { join, posix } from "node:path";
import { testTempParent } from "../../../src/temp-parent-policy.js";

it("moves only macOS's default temporary parents, including equivalent spellings", () => {
  const home = join("chosen-private-parent", "chosen-home");
  for (const parent of ["/tmp", "/private/tmp/", "/tmp/unused/..", "/var/folders/ab/session/T/", "/private/var/folders/ab/session/T/./"]) {
    expect(testTempParent(parent, "darwin", home, posix.resolve)).toBe(join(home, ".petrina", "test-tmp"));
  }
  for (const parent of ["/var/folders/ab/session/T/enclosing-run", "/private/var/folders/ab/session/T/custom", "chosen-private-parent"]) {
    expect(testTempParent(parent, "darwin", home, posix.resolve)).toBe(parent);
  }
  for (const platform of ["linux", "win32"] as const) expect(testTempParent("/tmp", platform, home, posix.resolve)).toBe("/tmp");
});
