import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoginShellProcess } from "../../src/login-shell.js";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { CLEANUP_MS, runCommand } from "@petrina/test-support/commands";
import { removeDir, tempDir, waitForFile } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";

/** A real ready actor with independent parent-death cleanup; no login shell or account setup. */
export async function preparedLoginShell(kind: "success" | "closed-output" | "stubborn" | "held-output" | "waiting") {
  const root = tempDir("petrina-owned-login-shell-"), lease = await createProcessLease();
  const ready = join(root, "ready"), go = join(root, "go"), helperReady = join(root, "holder-ready");
  const env = { HOME: root, TMPDIR: root, SHELL: "private-ready-shell" };
  const signals: string[] = [];
  const helper = lease.program(`require("node:fs").writeFileSync(${JSON.stringify(helperReady)}, "ready"); await new Promise(() => {});`);
  const holdOutput = kind === "held-output" ? `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: ["ignore", "inherit", "ignore"] });
    while (!existsSync(${JSON.stringify(helperReady)})) await Bun.sleep(5);
  ` : "";
  const output = kind === "success" || kind === "closed-output" || kind === "held-output"
    ? 'await Bun.write(Bun.stdout, "__petrina_env__\\nPATH=/private/bin:/usr/bin\\n__petrina_env__\\n");' : "";
  const body = lease.program(`
    const { existsSync, writeFileSync, closeSync } = require("node:fs");
    process.on("SIGTERM", () => { ${kind === "stubborn" ? "" : "process.exit(0);"} });
    ${holdOutput}
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(5);
    ${output}
    ${kind === "closed-output" ? "closeSync(1);" : ""}
    ${kind === "success" || kind === "held-output" ? "" : "await new Promise(() => {});"}
  `);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const close = async () => {
    try {
      await lease.close();
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child) await runCommand([process.execPath, "prepared-login-shell-cleanup"], {
        timeoutMs: CLEANUP_MS * SLOW,
        start: () => ({ pid: child!.pid, exited: child!.exited, get exitCode() { return child!.exitCode; }, get signalCode() { return child!.signalCode; }, kill: signal => child!.kill(signal) }),
      });
    } finally { removeDir(root); }
  };
  try {
    const owned = child = Bun.spawn([process.execPath, "-e", body], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    await waitForFile(ready, { during: owned.exited });
    const handle: LoginShellProcess = {
      stdout: owned.stdout, exited: owned.exited,
      get exitCode() { return owned.exitCode; }, get signalCode() { return owned.signalCode; },
      kill(signal) { signals.push(signal); return owned.kill(signal); },
    };
    return { env, handle, signals, start() { writeFileSync(go, "go"); return handle; }, close,
      get hasHeldOutput() { return existsSync(helperReady); },
    };
  } catch (error) { await close(); throw error; }
}
