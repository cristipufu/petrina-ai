import { expect, it } from "bun:test";
import { processHost } from "../../../src/process-host.js";
import { childState } from "../../../src/process-tree.js";
import { runCommand } from "@petrina/test-support/commands";
import { waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";

it.skipIf(!processHost.stopTree)("stops a real owned Windows process through the production adapter", async () => {
  const stop = new AbortController();
  let output = "";
  const child = runCommand([process.execPath, "-e", "console.log(process.pid); await Bun.sleep(300_000);"], {
    signal: stop.signal, timeoutMs: 10_000 * SLOW,
    onOutput: (text, stream) => { if (stream === "stdout") output += text; return undefined; },
  });
  const settled = child.catch(() => undefined);
  try {
    const pid = await waitFor(() => Number(output.trim()) || undefined, "the owned Windows process to report its identity");
    expect(await processHost.stopTree!(pid, 3000)).toBe(true);
    await child;
    expect(await childState(pid)).toBe("ended");
  } finally { stop.abort(); await settled; }
});
