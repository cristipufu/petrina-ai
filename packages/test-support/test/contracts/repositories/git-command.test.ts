import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommand } from "../../../src/git-program.js";
import { git } from "../../../src/commands.js";
import { tempDir, removeDir } from "../../../src/fixtures.js";
import { makeProduct } from "../../../src/repositories.js";

it("passes literal arguments and explicitly native paths through Git's real cross-platform shell", async () => {
  const root = tempDir("petrina-git-command-");
  try {
    const clone = await makeProduct(root), folder = join(root, "space and apostrophe's"); mkdirSync(folder);
    const actor = join(folder, "arguments.ts");
    writeFileSync(actor, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const literals = ["space text", "apostrophe's", String.raw`keep\backslash\n`, "$(never-run)"];
    const windows = String.raw`C:\space and apostrophe's\argument`;
    const command = gitCommand([{ path: process.execPath }, { path: actor }, ...literals, { path: windows }]);
    const output = await git(clone, "-c", `alias.fixture=!${command}`, "fixture");
    expect(JSON.parse(output)).toEqual([...literals, windows.replaceAll("\\", "/")]);
  } finally { removeDir(root); }
});
