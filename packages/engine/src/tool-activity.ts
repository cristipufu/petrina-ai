// Translate tool metadata into public activity and permission descriptions.
import { ADAPTERS } from "./tools.js";

const humanizeCommand = (command: string): string => {
  const c = command.toLowerCase();
  if (/\b(vitest|jest|pytest|cargo test|go test|bun test|npm test|bun run test|npm run test|playwright)\b/.test(c)) return "Running the tests";
  if (/\b(tsc|typecheck|cargo check|cargo build|vite build|bun run build|npm run build)\b/.test(c)) return "Checking that it builds";
  if (/\b(npm (install|i)|bun (add|install)|pnpm (add|install)|yarn add|pip install|cargo add)\b/.test(c)) return "Installing packages";
  if (/\bgit (push)\b/.test(c)) return "Pushing to GitHub";
  if (/\bgh (pr|release)\b/.test(c)) return "Talking to GitHub";
  if (/\bgit\b/.test(c)) return "Looking at the history";
  if (/\b(rg|grep|find|ls|cat|sed -n|head|tail)\b/.test(c)) return "Reading the code";
  return "Running a command";
};

// Windows tools report paths with backslashes.
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export interface ToolActivity {
  title?: string | null;
  kind?: string | null;
  locations?: { path: string }[] | null;
  rawInput?: unknown;
  _meta?: Record<string, unknown> | null;
}

function toolMetadata(update: ToolActivity): Record<string, unknown> | undefined {
  if (!update._meta) return undefined;
  for (const adapter of Object.values(ADAPTERS)) {
    const metadata = adapter.toolMetadata?.(update._meta);
    if (metadata) return metadata;
  }
}

function browserAction(update: ToolActivity): { action: string; input: Record<string, unknown> } | undefined {
  const metadata = toolMetadata(update);
  const mcp = update._meta?.mcp;
  const mcpTool = mcp && typeof mcp === "object" && "tool" in mcp ? mcp.tool : undefined;
  let name = typeof metadata?.name === "string" ? metadata.name : typeof mcpTool === "string" ? mcpTool : update.title ?? "";
  let input = update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) ? update.rawInput as Record<string, unknown> : {};
  if (/^(?:use_tool|call_tool)$/i.test(name)) {
    const wrapped = input.tool_name ?? input.name;
    if (typeof wrapped !== "string") return undefined;
    name = wrapped;
    const args = input.arguments ?? input.args ?? input.parameters;
    input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  }
  if (name === "call_mcp_tool" && typeof input.ToolName === "string") {
    name = input.ToolName;
    const args = input.Arguments;
    input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  }
  const action = browserName(name);
  return action ? { action, input } : undefined;
}

const browserName = (name: string) => /(?:^|__)browser_([a-z_]+)$/i.exec(name.trim().replace(/^Running\s+/i, ""))?.[1]?.toLowerCase();

const BROWSER_ACTIONS: Record<string, string> = {
  navigate: "Opening a page", navigate_back: "Going back a page", snapshot: "Reading the page",
  find: "Finding text on the page", take_screenshot: "Taking a picture", click: "Clicking on the page",
  type: "Typing on the page", fill_form: "Filling in a form", select_option: "Choosing an option",
  press_key: "Using the keyboard", hover: "Pointing at the page", drag: "Dragging on the page",
  wait_for: "Waiting for the page", console_messages: "Checking page messages",
  network_requests: "Checking page requests", tabs: "Checking browser tabs", close: "Closing the page",
  resize: "Resizing the page", evaluate: "Checking the page", run_code: "Checking the page",
};

/** Permission targets come only from named fields, never from executable browser payloads. */
export function browserTarget(update: ToolActivity): string | undefined {
  const browser = browserAction(update);
  if (!browser) return undefined;
  const input = browser.input;
  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      if (url.protocol === "http:" || url.protocol === "https:") return `Page: ${url.origin}${url.pathname}`.slice(0, 240);
    } catch { /* Missing or malformed metadata gives no target. */ }
  }
  if (typeof input.element === "string" && input.element.trim()) return `On the page: ${input.element.trim().replace(/\s+/g, " ")}`.slice(0, 240);
  return undefined;
}

// Grok puts the kind in its metadata, and older tools sometimes send only their name.
// All of them use the same descriptions below once the action is identified.
const TOOL_NAMES: Record<string, string> = {
  read: "read", readfile: "read", hashlineread: "read", listdir: "read",
  grep: "search", hashlinegrep: "search", glob: "search",
  bash: "execute", shell: "execute", execcommand: "execute", runcommand: "execute", runterminalcmd: "execute", runterminalcommand: "execute", monitor: "execute",
  edit: "edit", write: "edit", searchreplace: "edit", hashlineedit: "edit", strreplace: "edit", editnotebook: "edit", applypatch: "edit",
  delete: "delete", websearch: "fetch", webfetch: "fetch", xsearch: "fetch",
};

export function kindOf(update: ToolActivity): string {
  if (update.kind && update.kind !== "other") return update.kind;
  const tool = toolMetadata(update);
  const kind = tool?.kind;
  if (typeof kind === "string") {
    if (["read", "search", "edit", "delete", "move", "execute", "think", "fetch"].includes(kind)) return kind;
    if (kind === "write") return "edit";
    if (kind === "list") return "read";
    if (kind === "monitor") return "execute";
  }
  const name = typeof tool?.name === "string" ? tool.name : update.title ?? "";
  return TOOL_NAMES[name.trim().replace(/_/g, "").toLowerCase()] ?? "other";
}

function fileOf(update: ToolActivity): string | undefined {
  const location = update.locations?.[0]?.path;
  if (location) return location;
  if (!update.rawInput || typeof update.rawInput !== "object") return undefined;
  const input = update.rawInput as Record<string, unknown>;
  const file = input.target_file ?? input.file_path ?? input.path ?? input.filePath;
  return typeof file === "string" && file.trim() ? file : undefined;
}

export function describeTool(update: ToolActivity): string {
  const browser = browserAction(update);
  if (browser) return BROWSER_ACTIONS[browser.action] ?? "Using the browser";
  const kind = kindOf(update);
  const command = commandOf(update.rawInput);
  const file = fileOf(update);
  switch (kind) {
    case "read":
      return file ? `Reading ${baseName(file)}` : "Reading the code";
    case "search":
      return "Searching the code";
    case "edit":
      return file ? `Editing ${baseName(file)}` : "Editing files";
    case "delete":
      return file ? `Removing ${baseName(file)}` : "Removing files";
    case "move":
      return "Moving files";
    case "execute": {
      // Use the agent's description when it says what the command is for.
      const purpose = purposeOf(update.rawInput);
      return purpose ?? (command ? humanizeCommand(command) : "Running a command");
    }
    case "think":
      return "Thinking it through";
    case "fetch":
      return "Looking something up";
    default:
      return update.title ? (!/\s/.test(update.title) && /[_]|^(?:mcp|functions)[.:]/i.test(update.title) ? "Using a tool" : update.title.slice(0, 80)) : "Working";
  }
}

/** The agent's own one-line description of a command, when its tool gives one. */
function purposeOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const input = rawInput as { description?: unknown; toolAction?: unknown; toolSummary?: unknown };
  const value = input.description ?? input.toolAction ?? input.toolSummary;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length < 3) return undefined;
  const browser = browserName(text);
  if (browser) return BROWSER_ACTIONS[browser] ?? "Using the browser";
  const line = text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
  return line[0]!.toUpperCase() + line.slice(1);
}

/** The tools' own plumbing (loading tools, to-do bookkeeping): never shown as what the agent is doing. */
const PLUMBING = /^(ToolSearch|TodoWrite|TodoRead|Task(Output|Stop|Create|Update|Get|List)?|Skill|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|todo_write|search_tool|enter_plan_mode|exit_plan_mode|get_task_output|get_command_or_subagent_output|wait_tasks|wait_commands_or_subagents|kill_task|kill_command_or_subagent)$/i;

export function isPlumbing(update: ToolActivity): boolean {
  const tool = toolMetadata(update);
  const name = typeof tool?.name === "string" ? tool.name : update.title ?? "";
  return kindOf(update) === "other" && (tool?.kind === "plan" || PLUMBING.test(name.trim()));
}

export function commandOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const input = rawInput as { command?: unknown; cmd?: unknown; CommandLine?: unknown };
  const value = input.command ?? input.cmd ?? input.CommandLine;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join(" ");
  return undefined;
}
