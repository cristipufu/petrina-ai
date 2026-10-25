import { expect, it } from "vitest";
import { matchesCheckLogIdentity } from "../../../src/check-evidence.js";

it("matches saved diagnostic identities without rounding large device and inode values", () => {
  const expected = { device: "9007199254740993", inode: "18446744073709551614" };
  const actual = { dev: 9007199254740993n, ino: 18446744073709551614n };
  expect(String(Number(expected.device))).not.toBe(expected.device);
  expect(matchesCheckLogIdentity(expected, actual)).toBe(true);
  expect(matchesCheckLogIdentity({ ...expected, inode: "18446744073709551613" }, actual)).toBe(false);
});
