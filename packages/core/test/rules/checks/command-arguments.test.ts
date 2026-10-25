import { describe as originalDescribe } from "vitest";
import { expect, it } from "vitest";
import { parseCommand } from "../../../src/check-commands.js";

originalDescribe("a product's checks", () => {
it("reads a typed command into arguments, without a shell", () => {
    expect(parseCommand(`dotnet test "My App.sln" --nologo`)).toEqual(["dotnet", "test", "My App.sln", "--nologo"]);
    expect(parseCommand("bun run test && rm -rf /")).toEqual(["bun", "run", "test", "&&", "rm", "-rf", "/"]);
  });
});
