import { expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { browserTempRoot } from "../../../src/browser.js";

it("keeps the native default browser root", () => {
  expect(browserTempRoot()).toBe(process.platform === "darwin" ? join(homedir(), ".petrina", "b") : join(tmpdir(), "petrina-browsers"));
});
