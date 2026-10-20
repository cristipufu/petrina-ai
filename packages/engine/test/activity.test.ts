import { describe, expect, it } from "bun:test";
import { browserTarget, describeTool, isPlumbing } from "../src/tool-activity.js";

// Grok's saved ACP calls put the kind here instead of in ACP's top-level field.
const grok = (name: string, kind: string, rawInput: unknown = {}) => ({ title: name, rawInput, _meta: { "x.ai/tool": { version: 1, name, kind, namespace: "grok_build" } } });

describe("plain agent activity across tools", () => {
  it("describes direct and wrapped browser actions without exposing runtime tool names", () => {
    for (const call of [
      { title: "petrina-browser-a09ab187__browser_find", kind: "search" },
      grok("use_tool", "other", { tool_name: "petrina-browser-a09ab187__browser_find", arguments: { text: "Backlog" } }),
      { title: "call_tool", rawInput: { name: "browser_find", args: {} } },
    ]) expect(describeTool(call)).toBe("Finding text on the page");
    expect(describeTool({ title: "use_tool", rawInput: { tool_name: "browser_take_screenshot", arguments: {} } })).toBe("Taking a picture");
    expect(describeTool({ title: "mcp__page__browser_snapshot" })).toBe("Reading the page");
    expect(describeTool({ title: "use_tool" })).toBe("Using a tool");
    expect(describeTool({ title: "unknown_raw_tool", rawInput: { code: "private executable payload" } })).toBe("Using a tool");
    expect(describeTool({ title: "browser_future_action" })).toBe("Using the browser");
  });

  it("names browser permission targets only when supplied, without code, credentials or query strings", () => {
    expect(browserTarget({ title: "browser_navigate", rawInput: { url: "https://user:secret@example.com/page?token=secret#private" } })).toBe("Page: https://example.com/page");
    expect(browserTarget({ title: "use_tool", rawInput: { tool_name: "browser_click", arguments: { element: "Backlog task" } } })).toBe("On the page: Backlog task");
    expect(browserTarget({ title: "browser_evaluate", rawInput: { code: "secret code" } })).toBeUndefined();
    expect(browserTarget({ title: "browser_navigate", rawInput: { url: "bad url" } })).toBeUndefined();
  });

  it("describes Grok searches just like other tools, even without metadata", () => {
    for (const call of [
      { title: "Search", kind: "search" },
      grok("grep", "search", { pattern: "greeting", glob: "*.ts" }),
      { title: "grep", kind: "other", rawInput: { pattern: "greeting" } },
      { title: "hashline_grep" },
      { title: "Grep" },
      { title: "Glob" },
    ]) expect(describeTool(call)).toBe("Searching the code");
  });

  it("describes file reads without exposing the full path or the raw tool name", () => {
    for (const call of [
      { kind: "read", locations: [{ path: "/shop/notes.txt" }] },
      grok("read_file", "read", { target_file: "/shop/notes.txt" }),
      { title: "hashline_read", rawInput: { target_file: "C:\\shop\\notes.txt" } },
      { title: "Read", rawInput: { file_path: "/shop/notes.txt" } },
      { title: "read_file", rawInput: { path: "/shop/notes.txt" } },
    ]) expect(describeTool(call)).toBe("Reading notes.txt");
    expect(describeTool(grok("read_file", "read"))).toBe("Reading the code");
    expect(describeTool(grok("list_dir", "list", { target_directory: "/shop" }))).toBe("Reading the code");
  });

  it("uses the command's purpose for Grok and Claude, and recognises tests for every tool", () => {
    const input = { command: "bun test", description: "check that the greeting appears" };
    for (const call of [
      { kind: "execute", rawInput: input },
      grok("run_terminal_command", "execute", input),
      { title: "run_terminal_cmd", rawInput: input },
      { title: "Shell", rawInput: input },
    ]) expect(describeTool(call)).toBe("Check that the greeting appears");
    for (const call of [
      { kind: "execute", rawInput: { command: "bun test" } },
      grok("run_terminal_command", "execute", { command: "bun test" }),
      { title: "run_terminal_command", rawInput: { command: "bun test" } },
      { title: "Bash", rawInput: { command: "bun test" } },
      { title: "exec_command", rawInput: { cmd: ["bun", "test"] } },
    ]) expect(describeTool(call)).toBe("Running the tests");
    expect(describeTool(grok("run_terminal_command", "execute", { command: "date" }))).toBe("Running a command");
    expect(describeTool(grok("monitor", "monitor", { command: "bun run build" }))).toBe("Checking that it builds");
  });

  it("also covers Grok's file changes and web lookups", () => {
    for (const call of [
      { kind: "edit", locations: [{ path: "/shop/notes.txt" }] },
      grok("search_replace", "edit", { file_path: "/shop/notes.txt" }),
      grok("write", "write", { file_path: "/shop/notes.txt" }),
      { title: "hashline_edit", rawInput: { file_path: "/shop/notes.txt" } },
    ]) expect(describeTool(call)).toBe("Editing notes.txt");
    for (const title of ["web_search", "web_fetch", "WebSearch", "WebFetch"]) expect(describeTool({ title })).toBe("Looking something up");
  });

  it("keeps bookkeeping out of activity, including Grok's to-do and background-command tools", () => {
    for (const call of [
      { title: "TodoWrite", kind: "other" },
      grok("todo_write", "plan", { todos: [] }),
      { title: "todo_write" },
      grok("search_tool", "search_tool"),
      grok("get_command_or_subagent_output", "background_task_action"),
      { title: "wait_commands_or_subagents" },
      { title: "kill_command_or_subagent" },
    ]) expect(isPlumbing(call)).toBe(true);
    expect(isPlumbing(grok("grep", "search"))).toBe(false);
    expect(isPlumbing({ title: "ToolSearch", kind: "read" })).toBe(false);
  });

  it("keeps standard ACP kinds authoritative and tolerates missing or malformed metadata", () => {
    expect(describeTool({ ...grok("read_file", "read"), kind: "search" })).toBe("Searching the code");
    expect(describeTool({ title: "read_file", _meta: { "x.ai/tool": "read" }, rawInput: null })).toBe("Reading the code");
    expect(describeTool({ kind: "read", rawInput: { target_file: 123 } })).toBe("Reading the code");
    expect(describeTool({ kind: "read", locations: [{ path: "/shop/notes.txt" }], rawInput: { path: "/wrong/file.txt" } })).toBe("Reading notes.txt");
    expect(describeTool({ title: "Checking the greeting" })).toBe("Checking the greeting");
    expect(describeTool({})).toBe("Working");
  });
});
