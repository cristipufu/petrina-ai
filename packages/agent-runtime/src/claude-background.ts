import { SettingsManager } from "@agentclientprotocol/claude-agent-acp";

/** Turn off inherited plugins through Claude's session settings, preserving its other settings,
 * including the coordinator's sandbox additions. No settings files are changed. */
export async function claudeBackground(cwd: string): Promise<Record<string, unknown>> {
  const manager = new SettingsManager(cwd, {
    logger: {
      log() {},
      error() {},
    },
  });
  let effective: { enabledPlugins?: Record<string, unknown> };
  try {
    await manager.initialize();
    effective = manager.getSettings();
  } finally {
    manager.dispose();
  }
  return {
    strictMcpConfig: true,
    plugins: [],
    extraArgs: { "no-chrome": null },
    settings: {
      enabledPlugins: Object.fromEntries(Object.keys(effective.enabledPlugins ?? {}).map((id) => [id, false])),
      syncClaudeAiPlugins: false,
    },
    tools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Agent",
      "Task",
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TaskOutput",
      "TaskStop",
      "ToolSearch",
      "EnterPlanMode",
      "ExitPlanMode",
      "Skill",
      "NotebookEdit",
    ],
    disallowedTools: ["mcp__claude-in-chrome__*", "Computer", "ComputerUse"],
  };
}
