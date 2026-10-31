import { expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser, BrowserStartupCleanupError } from "../../../src/browser.js";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { tempDir, removeDir, waitFor, testBrowserRoot } from "@petrina/test-support/fixtures";
import type { BrowserStartupEffects } from "../../../src/browser.js";

for (const stubborn of [false, true]) it(`settles a malformed startup deadline and ${stubborn ? "forces" : "stops"} its owned helper before removing output`, async () => {
  const root = tempDir("petrina-browser-startup-error-"), browsers = testBrowserRoot(), registry = join(root, "registry");
  const ready = join(root, "ready"), release = join(root, "release"), lease = await createProcessLease(), actor = join(root, "actor.ts");
  writeFileSync(actor, lease.program(`const { existsSync, writeFileSync } = require("node:fs"); ${stubborn ? 'process.on("SIGTERM", () => undefined);' : ""}
    writeFileSync(${JSON.stringify(ready)}, "ready"); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    process.stdout.write("{broken\\n"); await new Promise(() => undefined);`));
  const child = spawn(process.execPath, [actor], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let directory: string | undefined, removedBeforeClose: boolean | undefined;
  child.once("close", () => { removedBeforeClose = directory === undefined || !existsSync(directory); });
  class Startup implements BrowserStartupEffects {
    readonly pending = new Set<ReturnType<typeof setTimeout>>();
    readonly budgets: number[] = [];
    launch(folder: string): ChildProcess { directory = folder; queueMicrotask(() => writeFileSync(release, "go")); return child; }
    arm(expired: () => void, ms: number) {
      this.budgets.push(ms);
      const timer = setTimeout(() => { this.pending.delete(timer); expired(); }, ms); this.pending.add(timer);
      return () => { clearTimeout(timer); this.pending.delete(timer); };
    }
  }
  const effects = new Startup();
  try {
    await waitFor(() => existsSync(ready), "the owned malformed-output helper to be ready");
    let error: unknown;
    try { await AgentBrowser.start(registry, process.env, undefined, browsers, undefined, effects); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The headless browser server could not start.");
    expect(error instanceof BrowserStartupCleanupError).toBe(false);
    expect(effects.budgets[0]).toBe(30_000);
    expect(effects.pending.size).toBe(0);
    expect(removedBeforeClose).toBe(false);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(directory!)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
  } finally {
    await lease.close(); await closed;
    removeDir(root); removeDir(browsers);
  }
});

it("retains startup recovery ownership and the original error when the owned helper cannot be confirmed stopped", async () => {
  const root = tempDir("petrina-browser-startup-uncertain-"), browsers = testBrowserRoot(), registry = join(root, "registry");
  const ready = join(root, "ready"), release = join(root, "release"), lease = await createProcessLease(), actor = join(root, "actor.ts");
  writeFileSync(actor, lease.program(`const { existsSync, writeFileSync } = require("node:fs"); writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5); process.stdout.write("{broken\\n"); await new Promise(() => undefined);`));
  const child = spawn(process.execPath, [actor], { stdio: ["pipe", "pipe", "pipe"] }), kill = child.kill;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const signals: string[] = [];
  child.kill = signal => { signals.push(String(signal)); return false; };
  let directory: string | undefined;
  try {
    await waitFor(() => existsSync(ready), "the owned uncertain helper to be ready");
    let error: unknown;
    try { await AgentBrowser.start(registry, process.env, undefined, browsers, undefined, {
      launch(folder) { directory = folder; queueMicrotask(() => writeFileSync(release, "go")); return child; },
    }); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(BrowserStartupCleanupError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("The headless browser server could not start.");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(null);
    expect(existsSync(directory!)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
  } finally {
    child.kill = kill;
    await lease.close(); await closed;
    removeDir(root); removeDir(browsers);
  }
});

it("keeps a failed startup registered when the helper exits but another owned actor still holds its output open", async () => {
  const root = tempDir("petrina-browser-startup-pipe-"), browsers = testBrowserRoot(), registry = join(root, "registry");
  const ready = join(root, "ready"), sidecarReady = join(root, "sidecar-ready"), release = join(root, "release");
  const lease = await createProcessLease(), actor = join(root, "actor.ts"), sidecar = join(root, "sidecar.ts");
  writeFileSync(sidecar, lease.program(`require("node:fs").writeFileSync(${JSON.stringify(sidecarReady)}, "ready"); await new Promise(() => undefined);`));
  writeFileSync(actor, lease.program(`const { existsSync, writeFileSync } = require("node:fs");
    Bun.spawn([process.execPath, "--no-env-file", ${JSON.stringify(sidecar)}], { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true }).unref();
    while (!existsSync(${JSON.stringify(sidecarReady)})) await Bun.sleep(5); writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    await new Promise(resolve => process.stdout.write("{broken\\n", resolve)); process.exit(0);`));
  const child = spawn(process.execPath, [actor], { stdio: ["pipe", "pipe", "pipe"] });
  let outputClosed = false, directory: string | undefined;
  const closed = new Promise<void>(resolve => child.once("close", () => { outputClosed = true; resolve(); }));
  try {
    await waitFor(() => existsSync(ready), "both leased output-holding actors to be ready");
    let error: unknown;
    try { await AgentBrowser.start(registry, process.env, undefined, browsers, undefined, {
      launch(folder) { directory = folder; queueMicrotask(() => writeFileSync(release, "go")); return child; },
    }); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(BrowserStartupCleanupError);
    expect(((error as Error).cause as Error).message).toBe("The headless browser server could not start.");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(outputClosed).toBe(false);
    expect(existsSync(directory!)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
  } finally {
    await lease.close(); await closed;
    removeDir(root); removeDir(browsers);
  }
});
