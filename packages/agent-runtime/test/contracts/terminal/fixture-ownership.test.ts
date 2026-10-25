import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CommandFailure } from "@petrina/test-support/commands";
import { rejectionOf } from "@petrina/test-support/rejections";
import { terminalLauncher } from "../../fixtures/terminal-launcher.js";
import { removeDir, waitFor } from "@petrina/test-support/fixtures";
import { sessionState } from "../../../src/terminal.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it.skipIf(process.platform === "win32")("ends its owned launcher even when a release file cannot be written", async () => {
  const owner = await terminalLauncher(roots);
  let expectedCleanupError: unknown;
  try {
    writeFileSync(owner.hold, "");
    const copy = owner.run();
    await waitFor(() => owner.startCount() === 1, "the fixture's actual terminal actor to start", undefined, { during: copy.result });
    const release = join(owner.root, "missing", "release");
    owner.releaseOnClose(release);
    const failure = await rejectionOf(owner.close());
    expectedCleanupError = failure;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([expect.objectContaining({ code: "ENOENT", path: release })]);
    // A native exit with drained pipes, or confirmed owned cleanup, establishes that this actor ended.
    const result = await copy.result.then(result => ({ code: result.code }), error => ({ error }));
    if ("error" in result) {
      expect(result.error).toBeInstanceOf(CommandFailure);
      expect((result.error as CommandFailure).cleanup).toBe("confirmed");
    } else expect(Number.isInteger(result.code)).toBe(true);
    expect(await sessionState(owner.dir)).toBe("ended");
  } finally {
    // The expected filesystem error remains cached; cleanup has already settled every owned command.
    await owner.close().catch(error => {
      if (error !== expectedCleanupError) throw error;
    });
  }
});
