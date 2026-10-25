import { expect, it } from "bun:test";
import { mcpTools } from "../../../src/mcp-catalog.js";

it("MCP discovery does not describe consequential controls as additive-only or closed-world", () => {
  const tools = mcpTools();
  for (const name of ["inbox_approve", "inbox_recovery", "product_checks", "product_settings", "task_source", "screen_set", "screen_task", "screen_allow", "engine_stop", "engine_restart", "engine_resume", "learning_accept"]) {
    const tool = tools.find((tool) => tool.name === `petrina_${name}`)!;
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations).not.toHaveProperty("destructiveHint", false);
    expect(tool.annotations).not.toHaveProperty("openWorldHint", false);
    expect(tool.annotations.idempotentHint).toBe(true);
    expect(tool.inputSchema.required).toContain("requestId");
  }
  for (const name of ["task_inspect", "inbox_list", "journey_check"]) {
    expect(tools.find((tool) => tool.name === `petrina_${name}`)!.annotations.readOnlyHint).toBe(true);
  }
});
