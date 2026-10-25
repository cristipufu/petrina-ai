import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure, runCommand } from "../../src/commands.js";
import { createProcessLease } from "../../src/process-lease.js";
import { removeDir, tempDir, waitForFile } from "../../src/fixtures.js";

/** The real actor is ready before the settlement allowance begins; its lease is independent cleanup. */
export async function settlementPeer(honorsStop: boolean) {
  const root = tempDir("petrina-command-settlement-"), lease = await createProcessLease(), controller = new AbortController();
  const ready = join(root, "ready"), release = join(root, "release"), file = join(root, "actor.ts");
  let result: ReturnType<typeof runCommand> | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    // Independent cleanup uses the actual command owner before releasing the separate lease.
    controller.abort();
    if (result) try { await result; }
    catch (error) { if (!(error instanceof CommandFailure) || error.cleanup !== "confirmed") errors.push(error); }
    try { await lease.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "The independent settlement peer cleanup could not be confirmed");
    removeDir(root);
  })();
  try {
    writeFileSync(file, lease.program(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, "ready");
      ${honorsStop ? `while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5); process.stdout.write("drained-out\\n"); process.stderr.write("drained-err\\n");` : 'await new Promise(() => undefined);'}`));
    result = runCommand([process.execPath, "--no-env-file", file], { cwd: root, signal: controller.signal });
    void result.catch(() => undefined);
    await waitForFile(ready, { during: result });
    const owned = result;
    return { result: owned, abort: () => controller.abort(), requestStop() { writeFileSync(release, "stop"); }, ready: () => existsSync(ready), close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Settlement peer setup cleanup was not confirmed"); }
    throw error;
  }
}
