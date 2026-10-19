import { createRequire } from "node:module";
import { adapterEntry, ADAPTERS } from "./tools.js";

/** Turn off inherited plugins through Claude's session settings, preserving its other settings,
 * including the coordinator's sandbox additions. No settings files are changed. */
export async function claudeBackground(cwd: string): Promise<Record<string, unknown>> {
  const require = createRequire(adapterEntry(ADAPTERS["claude-code"]!));
  const sdk = await import(require.resolve("@anthropic-ai/claude-agent-sdk")) as {
    resolveSettings(options: { cwd: string }): Promise<{ effective: { enabledPlugins?: Record<string, unknown> } }>;
  };
  const { effective } = await sdk.resolveSettings({ cwd });
  return {
    strictMcpConfig: true,
    plugins: [],
    extraArgs: { "no-chrome": null },
    settings: { enabledPlugins: Object.fromEntries(Object.keys(effective.enabledPlugins ?? {}).map((id) => [id, false])), syncClaudeAiPlugins: false },
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop", "ToolSearch", "EnterPlanMode", "ExitPlanMode", "Skill", "NotebookEdit"],
    disallowedTools: ["mcp__claude-in-chrome__*", "Computer", "ComputerUse"],
  };
}
