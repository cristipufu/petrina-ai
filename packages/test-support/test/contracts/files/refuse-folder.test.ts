import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir, removeDir } from "../../../src/fixtures.js";
import { refuseFolder } from "../../../src/refuse-folder.js";
import { expectRejection } from "../../../src/rejections.js";

it("refuses only the private owned folder, including file URLs, then restores the actual APIs", async () => {
  const root = tempDir("petrina-refused-folder-"), owned = join(root, "owned space"), outside = join(root, "owned space-other");
  fs.mkdirSync(owned); fs.mkdirSync(outside);
  try {
    const fault = refuseFolder(owned);
  try {
    expect(() => fs.writeFileSync(join(owned, "sync"), "refused")).toThrow("EPERM");
    await expectRejection(files.writeFile(pathToFileURL(join(owned, "async")), "refused"), "EPERM");
    fs.writeFileSync(join(outside, "sync"), "allowed");
    await files.writeFile(join(outside, "async"), "allowed");
    expect(fs.readFileSync(join(outside, "async"), "utf8")).toBe("allowed");
    expect(fault.attempts).toEqual([join(owned, "sync"), join(owned, "async")]);
  } finally { fault.restore(); }
    fs.writeFileSync(join(owned, "sync"), "restored");
    await files.writeFile(join(owned, "async"), "restored");
    expect(fs.readFileSync(join(owned, "sync"), "utf8")).toBe("restored");
    expect(fs.readFileSync(join(owned, "async"), "utf8")).toBe("restored");
  } finally { removeDir(root); }
});
