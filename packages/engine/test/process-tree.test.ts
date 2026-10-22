import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childState, descendantsKnown, lostExit, parseChildState, parseDescendants, readProcessList, sharedRead } from "../src/process-tree.js";
import { defunctProcess, removeDir, tempDir, waitFor } from "./support.js";

const snapshot = "11 10\n12 11\n40 1\n";

describe("process-tree snapshots", () => {
  it("finds a child and a grandchild, and leaves an unrelated process out", () => {
    expect(parseDescendants(snapshot, [10])).toEqual([11, 12]);
  });

  it("distinguishes an empty tree from failure to read the process list", async () => {
    expect(parseDescendants("", [10])).toEqual([]);
    expect(await descendantsKnown([10], 100, async () => undefined)).toBeUndefined();
  });

  it("retries a failed read within its budget and returns the later snapshot", async () => {
    const timeouts: number[] = [];
    const result = await descendantsKnown([10], 3_200, async (timeout) => {
      timeouts.push(timeout);
      return timeouts.length === 1 ? undefined : snapshot;
    });
    expect(timeouts).toEqual([1_000, 2_000]);
    expect(result).toEqual([11, 12]);
  });

  it("does not reread a list that was read and has no descendants", async () => {
    let calls = 0;
    const listed = await descendantsKnown([10], 3_200, async () => {
      calls += 1;
      return "40 1\n";
    });
    expect(calls).toBe(1);
    expect(listed).toEqual([]);
  });

  for (const delay of [2_500, 3_999]) it(`preserves a consistently slow ${delay}ms first snapshot before stopping the parent`, async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    try {
      const result = await descendantsKnown([10], 4_800, async (timeout) => {
        timeouts.push(timeout);
        now += Math.min(delay, timeout);
        return delay < timeout ? snapshot : undefined;
      }, [4_000, 4_000]);
      expect(timeouts).toEqual([4_000]);
      expect(result).toEqual([11, 12]);
    } finally { clock.mockRestore(); }
  });

  it("recovers a hung first read while reserving the rest of the quit budget", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    try {
      const result = await descendantsKnown([10], 4_800, async (timeout) => {
        timeouts.push(timeout);
        now += timeouts.length === 1 ? timeout : 100;
        return timeouts.length === 1 ? undefined : snapshot;
      }, [4_000, 4_000]);
      expect(timeouts).toEqual([4_000, 800]);
      expect(result).toEqual([11, 12]);
      expect(now).toBe(4_100);
    } finally { clock.mockRestore(); }
  });

  it("lets a slow rescan use the remaining allowance without splitting it into shorter attempts", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const timeouts: number[] = [];
      const result = await descendantsKnown([10], 3_200, async (timeout) => {
        timeouts.push(timeout);
        now += Math.min(2_500, timeout);
        return timeout > 2_500 ? snapshot : undefined;
      }, [4_000, 4_000]);
      expect(timeouts).toEqual([3_200]);
      expect(result).toEqual([11, 12]);
    } finally { clock.mockRestore(); }
  });
});

describe("a child's state from the process list", () => {
  it("tells a running child from a defunct or missing one, and admits when a snapshot cannot say", () => {
    const listed = "11 10 Ss\n12 11 Z+\n40 1 SN\n";
    expect(parseChildState(listed, 11)).toBe("running");
    expect(parseChildState(listed, 12)).toBe("ended");
    expect(parseChildState(listed, 40)).toBe("running");
    expect(parseChildState(listed, 99)).toBe("ended");
    // A snapshot without a state column (an older helper) cannot tell a defunct child from a running one.
    expect(parseChildState("11 10\n", 11)).toBe("unknown");
    // Descendants still read from the same snapshot.
    expect(parseDescendants(listed, [10])).toEqual([11, 12]);
  });
});

describe("a live process-list read", () => {
  const folders: string[] = [];
  afterAll(() => folders.forEach(removeDir));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it.skipIf(process.platform === "win32")("lists this process and settles well within its deadline", async () => {
    const started = Date.now();
    const list = await readProcessList(4_000);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(list).toBeDefined();
    expect(list!.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === process.pid)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reads whether a child is running, defunct or already collected", async () => {
    expect(await childState(process.pid, 4_000)).toBe("running");
    const defunct = await defunctProcess();
    try {
      await waitFor(async () => (await childState(defunct.pid, 4_000)) === "ended", "the defunct process to show as ended", 10_000);
      // Existence alone says nothing: the defunct process still has its number.
      expect(alive(defunct.pid)).toBe(true);
    } finally { await defunct.release(); }
    const collected = Bun.spawn(["sh", "-c", "exit 0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await collected.exited;
    expect(await childState(collected.pid, 4_000)).toBe("ended");
    // Without a readable list, the state is unknown rather than guessed.
    expect(await childState(process.pid, 4_000, async () => undefined)).toBe("unknown");
  });

  it.skipIf(process.platform === "win32")("settles as failed at its deadline and kills the helper when the system never reports the helper's exit", async () => {
    // A helper that ignores the runtime's stop signal and lingers is what a finished child whose exit the
    // system lost looks like to the read: the runtime's own timeout never settles its callback.
    const bin = tempDir("petrina-ps-stand-in-"); folders.push(bin);
    const pidFile = join(bin, "pid");
    writeFileSync(join(bin, "ps"), `#!/bin/sh
trap '' TERM
echo $$ > "${pidFile}"
exec sleep 30
`, { mode: 0o755 });
    const recorded = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || undefined : undefined;
    // A Mac can hold a new program's first start for a while: start the stand-in once outside the measured read.
    const warm = Bun.spawn([join(bin, "ps")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const warmPid = await waitFor(recorded, "the stand-in helper to start once", 60_000);
    warm.kill("SIGKILL");
    await waitFor(() => !alive(warmPid), "the warm-up helper to be gone", 10_000);
    rmSync(pidFile);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const started = Date.now();
      expect(await readProcessList(300)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = await waitFor(recorded, "the lingering helper's pid", 10_000);
      expect(pid).not.toBe(warmPid);
      await waitFor(() => !alive(pid), "the lingering helper to be killed", 10_000);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("process-list reads shared by the watchers asking at once", () => {
  const controlled = () => {
    const pending: ((value: string | undefined) => void)[] = [];
    const read = (_timeout: number) => new Promise<string | undefined>((resolve) => { pending.push(resolve); });
    return { read, pending, settle: (value: string | undefined) => pending.shift()!(value) };
  };

  it("runs one read at a time: askers at the same moment share it, later askers get a snapshot taken after they asked", async () => {
    const list = controlled();
    const since = Date.now();
    const together = [sharedRead(list.read, 300, since), sharedRead(list.read, 300, since), sharedRead(list.read, 300, since)];
    expect(list.pending).toHaveLength(1);
    // A child that may be newer than the read under way could be missing from its snapshot: these wait for the next read.
    const later = [sharedRead(list.read, 300, Date.now() + 1), sharedRead(list.read, 300, Date.now() + 1)];
    expect(list.pending).toHaveLength(1);
    list.settle("1 0 S\n");
    expect(await Promise.all(together)).toEqual(["1 0 S\n", "1 0 S\n", "1 0 S\n"]);
    await waitFor(() => list.pending.length === 1, "the queued read to start");
    list.settle("2 0 S\n");
    expect(await Promise.all(later)).toEqual(["2 0 S\n", "2 0 S\n"]);
    // Nothing under way: a fresh ask starts a fresh read, and a failed read is reported as such without wedging the next.
    const failed = sharedRead(list.read, 300, Date.now());
    expect(list.pending).toHaveLength(1);
    list.settle(undefined);
    expect(await failed).toBeUndefined();
    const fresh = sharedRead(list.read, 300, Date.now());
    expect(list.pending).toHaveLength(1);
    list.settle("3 0 S\n");
    expect(await fresh).toBe("3 0 S\n");
  });

  it.skipIf(process.platform === "win32")("gives the watches of many children one helper at a time", async () => {
    // Two dozen children close their output together and their exits go unreported for a while: their watches
    // read the process list once, together, instead of starting two dozen helpers at the same moment.
    let reads = 0, inFlight = 0, most = 0;
    const read = async (_timeout: number) => {
      reads += 1; inFlight += 1; most = Math.max(most, inFlight);
      await Bun.sleep(30);
      inFlight -= 1;
      return `${process.pid} 1 S\n`;
    };
    const stop = new AbortController();
    const watches = Array.from({ length: 24 }, () => lostExit(process.pid, stop.signal, read));
    await waitFor(() => reads > 0, "the first shared read");
    await Bun.sleep(200);
    expect(reads).toBe(1);
    expect(most).toBe(1);
    stop.abort();
    expect(await Promise.all(watches)).toEqual(Array.from({ length: 24 }, () => "stopped"));
  });
});
