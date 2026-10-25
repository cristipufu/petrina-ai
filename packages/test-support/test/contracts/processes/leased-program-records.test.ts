import { expect, it } from "bun:test";
import { join } from "node:path";
import { createLeasedProgramRecords } from "../../../src/leased-program-records.js";
import { runCommand, startCommand, type Started } from "../../../src/commands.js";
import { setupWithCleanup } from "../../../src/setup-with-cleanup.js";
import { settleCommandAfterStop } from "../../../src/command-settlement.js";
import { removeDir, tempDir, waitFor } from "../../../src/fixtures.js";

it("records a private launch and exit without treating its receipt as command completion", async () => {
  const root = tempDir("petrina-program-receipts-");
  let programs: Awaited<ReturnType<typeof createLeasedProgramRecords>> | undefined;
  const controller = new AbortController();
  let completion: ReturnType<typeof runCommand> | undefined, child: Started | undefined;
  try {
    programs = await setupWithCleanup(() => createLeasedProgramRecords(join(root, "actors")), () => removeDir(root));
    const owner = programs;
    const script = programs.write("actor.ts", "control", () => 'console.log("actual owned output"); await new Promise(() => undefined);');
    let output = "";
    completion = runCommand([process.execPath, "--no-env-file", script], { cwd: root, signal: controller.signal,
      start: (argv, options) => child = startCommand(argv, options),
      onOutput(text, stream) { if (stream === "stdout") output += text; return undefined; },
    });
    void completion.catch(() => undefined);
    const running = await waitFor(() => output.includes("actual owned output") && owner.records().find(record => record.state === "running"), "the actual leased actor to write output", undefined, { during: completion });
    expect(running).toMatchObject({ pid: child!.pid, kind: "control", state: "running" });
    expect(running.id).toMatch(/^[0-9a-f-]{36}$/);
    await programs.close();
    const ended = await completion;
    expect(ended.code).toBe(78);
    expect(ended.stdout).toBe("actual owned output\n");
    expect(programs.records()).toEqual([{ ...running, state: "ended", code: 78 }]);
    await programs.close();
  } finally {
    const stopped = await Promise.allSettled([
      ...(programs ? [programs.close()] : []),
      ...(completion ? [settleCommandAfterStop({ result: completion, abort: () => controller.abort() })] : []),
    ]);
    const errors = stopped.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, `Receipt control cleanup is unconfirmed; retained ${root}`);
    if (programs) removeDir(root);
  }
});
