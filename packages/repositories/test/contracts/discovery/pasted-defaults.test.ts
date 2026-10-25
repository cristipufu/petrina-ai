import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { expandPath } from "../../../src/discovery.js";

describe("Adding a product", () => {
it("expands a default pasted home through the native process environment", () => {
    expect(expandPath("~")).toBe(homedir());
});
});
