import { describe as originalDescribe } from "vitest";
import { expect, it } from "vitest";
import { commandText, commandInputText, parseCommand } from "../../../src/check-commands.js";

originalDescribe("a product's checks", () => {
it("reads a typed command into arguments, without a shell", () => {
    expect(parseCommand(`dotnet test "My App.sln" --nologo`)).toEqual(["dotnet", "test", "My App.sln", "--nologo"]);
    expect(parseCommand("bun run test && rm -rf /")).toEqual(["bun", "run", "test", "&&", "rm", "-rf", "/"]);
  });
});

const literalArguments: [string, string[]][] = [
  ["empty command", []], ["empty argument", ["program", ""]],
  ["spaces", ["Program Files/tool", "two words", " leading", "trailing "]],
  ["single quotes", ["program", "it's literal"]], ["double quotes", ["program", 'say "hello"']],
  ["both quotes", ["program", `both 'single' and "double"`]],
  ["literal backslashes", ["program", String.raw`one\two\n`]],
  ["Windows path", [String.raw`C:\Tools\tool.exe`, "file.ts"]],
  ["Windows spaces and apostrophe", [String.raw`C:\Users\O'Neil\Program Files\tool.exe`, ""]],
  ["UNC path", [String.raw`\\server\share\tool.exe`, String.raw`folder\file`]],
  ["device path", [String.raw`\\?\C:\Tools\tool.exe`, String.raw`\\.\pipe\fixture`]],
  ["line endings and tabs", ["program", "one\ntwo", "one\rtwo", "one\ttwo"]],
  ["Unicode", ["路径工具", "café", "🙂"]],
  ["shell-like literal arguments", ["program", "|", "&&", "$HOME", "`date`"]],
  ["inline script", ["bun", "-e", "require('node:fs').writeFileSync('output.txt', 'ran\\n')"]],
];
it.each(literalArguments)("preserves %s in coordinator command input", (_name, argv) => {
  expect(parseCommand(commandInputText(argv))).toEqual(argv);
});

it("keeps recorded command identities separate from editable input", () => {
  expect(commandText(["tool", "two words", ""])).toBe('tool "two words" ""');
  expect(commandText(["tool", "line\nnext", String.raw`C:\Tools\tool.exe`])).toBe(String.raw`tool "line\nnext" "C:\\Tools\\tool.exe"`);
  expect(commandText(["tool", 'say "hello"'])).toBe(String.raw`tool "say \"hello\""`);
});
