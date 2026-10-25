import {afterAll,describe,expect,it} from "bun:test";
import {existsSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {runCommand} from "@petrina/test-support/commands";
import {createProcessLease} from "@petrina/test-support/process-lease";
import {clearEnded,sessionState} from "../../../src/terminal.js";
import {removeDir,tempDir,waitFor} from "@petrina/test-support/fixtures";
const roots:string[]=[];afterAll(()=>roots.forEach(removeDir));

describe.skipIf(process.platform === "win32")("whether the app Petrina opened is still running", () => {
  const folder = (files: Record<string, string[]>) => {
    const dir = tempDir("petrina-status-");
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
    return dir;
  };
  const startedOf = async (pid: number) => {
    const result = await runCommand(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } });
    if (result.code !== 0) throw new Error("The owned process start time was not readable");
    return result.stdout.trim();
  };
  const record = async (pid: number) => [`pid=${pid}`, `started=${await startedOf(pid)}`];
  const gone = async () => {
    const result = await runCommand([process.execPath, "--no-env-file", "-e", "console.log(process.pid)"]);
    if (result.code !== 0) throw new Error("The short-lived process did not finish");
    return Number(result.stdout.trim());
  };

  it("running only when a copy's process id has the start time it noted", async () => {
    expect(await sessionState(folder({ [`run.${process.pid}`]: await record(process.pid) }))).toBe("running");
    // The same number, a different start time: the system gave it to another process.
    expect(await sessionState(folder({ [`run.${process.pid}`]: [`pid=${process.pid}`, "started=Mon Jan  1 00:00:00 2001"] }))).toBe("ended");
  });

  it("running while any copy runs, even after another one said it ended", async () => {
    const lease = await createProcessLease();
    let running: ReturnType<typeof runCommand> | undefined;
    try {
      const root = folder({}), ready = join(root, "ready"), actor = join(root, "actor.ts");
      writeFileSync(actor, lease.program(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)} + ".tmp", String(process.pid)); fs.renameSync(${JSON.stringify(ready)} + ".tmp", ${JSON.stringify(ready)}); await new Promise(() => {});`));
      running = runCommand([process.execPath, "--no-env-file", actor], { cwd: root });
      // Attach a handler immediately; the original result still fails this case when awaited.
      void running.catch(() => undefined);
      await waitFor(() => existsSync(ready), "the independently owned status actor to start", undefined, { during: running });
      const other = { pid: Number(readFileSync(ready, "utf8")) };
      const pid = await gone();
      const dir = folder({ status: ["state=ended", "code=0"], [`run.${pid}`]: [`pid=${pid}`, "started=whenever"], [`run.${other.pid}`]: await record(other.pid) });
      expect(await sessionState(dir)).toBe("running");
    } finally {
      await lease.close();
      await running;
    }
  });

  it("ended when the copy that opened the tool said so, or every copy is gone", async () => {
    expect(await sessionState(folder({ status: ["state=ended", "code=0"] }))).toBe("ended");
    const pid = await gone();
    expect(await sessionState(folder({ [`run.${pid}`]: [`pid=${pid}`, "started=whenever"] }))).toBe("ended");
  });

  it("unknown when no copy ever reported starting, or a record cannot be checked", async () => {
    const empty = tempDir("petrina-status-");
    roots.push(empty);
    expect(await sessionState(empty)).toBe("unknown");
    expect(await sessionState(join(empty, "missing"))).toBe("unknown");
    expect(await sessionState(folder({ [`run.${process.pid}`]: [`pid=${process.pid}`] }))).toBe("unknown");
    expect(await sessionState(folder({ status: ["something else"] }))).toBe("unknown");
  });

  it("opening again forgets what the last session left, and keeps the records of copies still running", async () => {
    const pid = await gone();
    const dir = folder({ status: ["state=ended", "code=0"], [`run.${pid}`]: [`pid=${pid}`, "started=whenever"], [`run.${process.pid}`]: await record(process.pid) });
    await clearEnded(dir);
    expect(readdirSync(dir).sort()).toEqual([`run.${process.pid}`]);
    rmSync(join(dir, `run.${process.pid}`));
    expect(await sessionState(dir)).toBe("unknown");
  });
});
