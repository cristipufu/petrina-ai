import { newProgramsStart } from "@petrina/test-support/new-program";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askMode } from "../../../src/terminal.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe.skipIf(process.platform === "win32")("Claude Code's ask-before-acting mode", () => {
  const help = async (text: string) => {
    await newProgramsStart();
    const dir = tempDir("petrina-help-");
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude");
    writeFileSync(file, `#!/bin/sh\necho '${text}'\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("uses the name the installed copy lists: manual now, default before", async () => {
    expect(
      await askMode(
        await help(
          '--permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
        ),
      ),
    ).toBe("manual");
    expect(
      await askMode(
        await help('--permission-mode <mode> (choices: "acceptEdits", "bypassPermissions", "default", "plan")'),
      ),
    ).toBe("default");
    const missing = tempDir("petrina-no-help-");
    roots.push(missing);
    expect(await askMode(join(missing, "missing"))).toBe("default");
  });
});
