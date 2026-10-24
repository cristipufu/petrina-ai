import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processList } from "@petrina/platform/process-tree";
import { tempDir, removeDir, waitFor } from "./fixtures.js";
import { currentSlow } from "./slow.js";

/**
 * A real defunct process in its own group. Its Bun parent pauses before the test ends the child,
 * so it cannot collect the exit until release resumes it. The parent then reaps its own child:
 * neither shell job control, an extra interpreter nor a container's PID 1 is responsible for cleanup.
 */
export async function defunctProcess(beforeRead?: (holderPid: number) => void): Promise<{ pid: number; holderPid: number; self: string; release(): Promise<void> }> {
  if (process.platform === "win32") throw new Error("Defunct processes are a POSIX-only boundary; use the Windows termination controls on Windows.");
  const root = tempDir("petrina-defunct-"), record = join(root, "child");
  const sleep = Bun.which("sleep");
  if (!sleep) { removeDir(root); throw new Error("The native process fixture requires the system's sleep program."); }
  const program = `
    const { writeFileSync, renameSync } = require("node:fs");
    const child = Bun.spawn([${JSON.stringify(sleep)}, "120"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const exited = child.exited;
    try {
      writeFileSync(${JSON.stringify(record + ".tmp")}, String(child.pid));
      renameSync(${JSON.stringify(record + ".tmp")}, ${JSON.stringify(record)});
      process.kill(process.pid, "SIGSTOP");
      await exited;
    } finally { child.kill("SIGKILL"); await exited; }
  `;
  const holder = Bun.spawn([process.execPath, "-e", program], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const holderExited = holder.exited;
  let pid: number | undefined, released: Promise<void> | undefined;
  const present = (id: number) => {
    try { process.kill(id, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const childNumber = () => existsSync(record) ? Number(readFileSync(record, "utf8")) || undefined : undefined;
  const holderPaused = async () => {
    const rows = (await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], 4_000 * currentSlow()))?.split("\n").map(line => line.trim().split(/\s+/));
    return rows?.some(([id, , , state]) => Number(id) === holder.pid && state?.startsWith("T"));
  };
  const release = () => released ??= (async () => {
    try {
      if (pid === undefined) {
        const saved = await waitFor(() => {
          const id = childNumber();
          return id ? { id } : holder.exitCode !== null ? {} : undefined;
        }, "the owned child's complete cleanup record or failed setup's exit", 5_000);
        pid = saved.id;
      }
      if (pid !== undefined) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      // A setup failure may precede the pause. Sending CONT too soon would be lost when the
      // parent reaches STOP, so observe that boundary before letting it reap and exit normally.
      if (holder.exitCode === null) {
        await waitFor(holderPaused, "the owned holder's pause before cleanup", 5_000);
        // Bun's subprocess kill handle does not deliver CONT to a stopped child.
        // This is the live owned holder, observed paused above, never a saved process number.
        process.kill(holder.pid, "SIGCONT");
      }
      await waitFor(() => holder.exitCode !== null, "the owned holder to reap its child and exit", 5_000);
    } finally {
      if (holder.exitCode === null) {
        try { process.kill(holder.pid, "SIGCONT"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        holder.kill("SIGKILL");
      }
      await holderExited;
    }
    if (pid !== undefined) await waitFor(() => !present(pid!) && !present(-pid!), "the owned defunct process and group to be collected", 5_000);
    removeDir(root);
  })();
  try {
    beforeRead?.(holder.pid);
    pid = await waitFor(childNumber, "the owned child's complete process record", 5_000);
    const target = pid;
    await waitFor(async () => {
      const rows = (await processList(["-A", "-o", "pid=,ppid=,pgid=,stat=,comm="], 4_000 * currentSlow()))?.split("\n").map(line => line.trim().split(/\s+/));
      const parent = rows?.find(([id]) => Number(id) === holder.pid), child = rows?.find(([id]) => Number(id) === target);
      return parent && parent[3]?.startsWith("T") && child && Number(child[1]) === holder.pid && Number(child[2]) === target;
    }, "the owned holder to pause before its child ends", 10_000);
    process.kill(target, "SIGKILL");
    const self = await waitFor(async () => {
      const rows = (await processList(["-A", "-o", "pid=,pgid=,stat="], 4_000 * currentSlow()))?.split("\n").map(line => line.trim().split(/\s+/));
      return rows?.some(([id, group, state]) => Number(id) === target && Number(group) === target && state?.startsWith("Z") && present(target))
        ? rows.find(([id]) => Number(id) === process.pid)?.join(" ") : undefined;
    }, "the real owned process and group to remain defunct", 10_000);
    return { pid: target, holderPid: holder.pid, self, release };
  } catch (error) { await release(); throw error; }
}
