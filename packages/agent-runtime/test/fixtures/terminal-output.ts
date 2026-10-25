import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputProcess } from "@petrina/platform/process-output";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { CLEANUP_MS, CommandFailure, runCommand } from "@petrina/test-support/commands";
import { removeDir, tempDir, waitForFile } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";

/** Ready native output/exit actors, independently leased before the adapter receives their real handle. */
export async function preparedTerminalOutput(kind: "success" | "nonzero" | "closed-stubborn") {
  const root = tempDir("petrina-terminal-output-");
  const lease = await setupWithCleanup(createProcessLease, () => removeDir(root));
  const ready = join(root, "ready"), release = join(root, "release"), closed = join(root, "closed"), file = join(root, "probe.ts");
  const signals: string[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    try { await lease.close(); } catch (error) { errors.push(error); }
    if (child) try {
      const owned = child;
      await runCommand([process.execPath, "owned-terminal-output-cleanup"], {
        timeoutMs: CLEANUP_MS * SLOW,
        start: () => ({ pid: owned.pid, exited: owned.exited, get exitCode() { return owned.exitCode; }, get signalCode() { return owned.signalCode; }, kill: signal => owned.kill(signal) }),
      });
    } catch (error) { if (!(error instanceof CommandFailure) || error.cleanup !== "confirmed") errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Terminal output fixture cleanup could not be confirmed");
    removeDir(root);
  })();
  return setupWithCleanup(async () => {
    writeFileSync(file, lease.program(`const fs = require("node:fs");
      process.on("SIGTERM", () => { ${kind === "closed-stubborn" ? "" : "process.exit(0);"} });
      fs.writeFileSync(${JSON.stringify(ready)}, "ready");
      while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
      await Bun.write(Bun.stdout, 'choices: "manual"\\n');
      ${kind === "closed-stubborn" ? `fs.closeSync(1); fs.writeFileSync(${JSON.stringify(closed)}, "closed"); await new Promise(() => undefined);` : `process.exit(${kind === "nonzero" ? 7 : 0});`}
    `));
    const owned = child = Bun.spawn([process.execPath, "--no-env-file", file], { cwd: root, env: { ...process.env, HOME: root, TMPDIR: root }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    await waitForFile(ready, { during: owned.exited });
    const handle: OutputProcess = { stdout: owned.stdout, exited: owned.exited,
      get exitCode() { return owned.exitCode; }, get signalCode() { return owned.signalCode; },
      kill(signal) { signals.push(signal); return owned.kill(signal); },
    };
    return { handle, signals, close, closed,
      start() { writeFileSync(release, "go"); return handle; },
    };
  }, close);
}
