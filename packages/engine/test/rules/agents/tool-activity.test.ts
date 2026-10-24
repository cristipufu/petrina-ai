import { expect, it } from "bun:test";
import { createToolActivity } from "../../../src/tool-activity.js";

const { describeTool, isPlumbing } = createToolActivity(() => undefined);

it("reads only the provider metadata interpretation supplied by its host", () => {
  const observed: Record<string, unknown>[] = [];
  const format = createToolActivity(meta => { observed.push(meta); return { kind: "read", name: "opaque_action" }; });
  expect(format.describeTool({ kind: "search" })).toBe("Searching the code");
  expect(observed).toEqual([]);
  const meta = { privateProviderNamespace: { opaque: "format" } };
  expect(format.describeTool({ _meta: meta, rawInput: { path: "C:\\shop\\notes.txt" } })).toBe("Reading notes.txt");
  expect(observed).toContain(meta);
  expect(describeTool({ _meta: meta })).toBe("Working");
});

it("says what a command is for, and hides the tools' own plumbing", () => {
  expect(describeTool({ kind: "execute", rawInput: { command: "rg -n stage src", description: "find where the engine records stage changes" } })).toBe("Find where the engine records stage changes");
  expect(describeTool({ kind: "execute", rawInput: { command: "bun test" } })).toBe("Running the tests");
  // Only the file's name, however the tool writes its path.
  expect(describeTool({ kind: "edit", locations: [{ path: "/Users/ana/shop/notes.txt" }] })).toBe("Editing notes.txt");
  expect(describeTool({ kind: "edit", locations: [{ path: "C:\\Users\\ana\\shop\\notes.txt" }] })).toBe("Editing notes.txt");
  expect(isPlumbing({ kind: "other", title: "ToolSearch" })).toBe(true);
  expect(isPlumbing({ kind: "other", title: "TodoWrite" })).toBe(true);
  expect(isPlumbing({ kind: "read", title: "Read notes.txt" })).toBe(false);
});
