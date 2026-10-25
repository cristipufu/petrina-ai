import { describe, expect, it } from "bun:test";
import { BACKGROUND } from "../../../src/prompts.js";
import { CLI } from "../../fixtures.js";
import { runCommand } from "@petrina/test-support/commands";

describe("the PATH an app opened from the Dock gets", () => {
it("keeps agents in the background", async () => {
    expect(BACKGROUND).toContain("Never open windows or apps");
    const result = await runCommand([process.execPath, CLI, "open"], { env: { ...process.env, PETRINA_AGENT: "1", PETRINA_HOME: "/nonexistent-petrina-home" } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Agents work in the background");
  });
});
