import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { waitFor } from "@petrina/test-support/fixtures";
import { ENGINE_TEST_ROOT } from "./runtime-paths.js";

export const alive = (pid: number): boolean => browserProcesses.exists(pid);
export const pidsIn = (path: string): number[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0) : [];

/** Every native actor has an independent loopback owner; PID files are observations, never signal authority. */
export async function shutdownActors(root: string) {
  const lease = await createProcessLease(), actor = join(root, "leased-agent.ts"), background = join(root, "leased-background.ts"), pids = join(root, "leased-actors");
  const record = `require("node:fs").appendFileSync(${JSON.stringify(pids)}, String(process.pid) + "\\n");`;
  writeFileSync(actor, lease.program(`${record} await import(${JSON.stringify(join(ENGINE_TEST_ROOT, "fake-agent.ts"))}); await new Promise(() => undefined);`));
  // Same output and delayed final TERM write as the native fake's default build, without a self-expiry
  // that could pass a stop assertion while the production cleanup is still waiting.
  writeFileSync(background, lease.program(`${record}
    const { mkdirSync, writeFileSync } = require("node:fs"); const dir = process.env.OUT;
    const write = () => { mkdirSync(dir, { recursive: true }); writeFileSync(dir + "/out.bin", "x"); };
    process.on("SIGTERM", () => setTimeout(() => { write(); process.exit(0); }, 300));
    const tick = () => { write(); setTimeout(tick, 100); }; tick(); await new Promise(() => undefined);`));
  return { actor, background, async close() {
    await lease.close();
    await waitFor(() => !pidsIn(pids).some(alive), "the independent shutdown fixture owner to stop all its actors", 5_000);
  } };
}
