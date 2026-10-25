import { newProgramsStart } from "@petrina/test-support/new-program";
import {afterAll,afterEach,beforeAll,describe,expect,it} from "bun:test";
import {existsSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {sessionState} from "../../../src/terminal.js";
import {removeDir,waitFor} from "@petrina/test-support/fixtures";
import {terminalLauncher,type TerminalLauncher} from "../../fixtures/terminal-launcher.js";
import {runCommand} from "@petrina/test-support/commands";
const roots:string[]=[];afterAll(()=>roots.forEach(removeDir));

describe.skipIf(process.platform === "win32")("the launcher runs one copy per task", () => {
  beforeAll(() => newProgramsStart());

  const owned: TerminalLauncher[] = [];
  afterEach(async () => { await Promise.all(owned.splice(0).map(owner => owner.close())); });
  const launcher = async () => { const owner = await terminalLauncher(roots); owned.push(owner); return owner; };

  /** Four copies started at the same moment: every one but one stops at once, saying the tool is open already, and the tool opens once. */
  async function together(it: Awaited<ReturnType<typeof launcher>>) {
    const before = it.startCount();
    const copies = Array.from({ length: 4 }, () => it.run());
    const refused = copies.map((copy) => copy.exited.then((code) => code === 1));
    await waitFor(async () => {
      const done = await Promise.all(refused.map((result) => Promise.race([result, Bun.sleep(10).then(() => false)])));
      return done.filter(Boolean).length === copies.length - 1 && it.startCount() === before + 1;
    }, "all copies but one to refuse", undefined, { during: Promise.all(copies.map(copy => copy.result)) });
    return copies;
  }

  /** A lock left by a copy that is gone: its process ended, and the start time is not its own. */
  async function goneCopysLock(dir: string) {
    const dead = await runCommand([process.execPath, "--no-env-file", "-e", "console.log(process.pid)"]);
    if (dead.code !== 0) throw new Error("The old lock owner did not finish");
    writeFileSync(join(dir, "lock"), `pid=${Number(dead.stdout.trim())}\nstarted=Mon Jan  1 00:00:00 2001\n`);
  }

  it("refuses every copy but one, even when they all start at the same moment", async () => {
    const it = await launcher();
    for (let round = 0; round < 8; round++) {
      writeFileSync(it.hold, "");
      const before = it.startCount();
      const copies = await together(it);
      expect(await sessionState(it.dir)).toBe("running");
      rmSync(it.hold);
      const codes = await Promise.all(copies.map((copy) => copy.exited));
      expect([...codes].sort()).toEqual([0, 1, 1, 1]);
      for (const [index, copy] of copies.entries()) if (codes[index] === 1) expect(await copy.stdout).toContain("Codex is already open in your terminal for this task. Use that window.");
      expect(it.startCount()).toBe(before + 1);
      expect(await sessionState(it.dir)).toBe("ended");
      // Nothing is left behind but the launcher, the ended note and the locks: one for each time the tool opened.
      const left = readdirSync(it.dir).filter((name) => !name.startsWith("open."));
      expect(left.filter((name) => !name.startsWith("lock"))).toEqual(["status"]);
      expect(left.filter((name) => name.startsWith("lock"))).toHaveLength(round + 1);
    }
  }, 60_000);

  it("takes over a lock left by a copy that is gone, and still refuses a second copy", async () => {
    const it = await launcher();
    await goneCopysLock(it.dir);
    writeFileSync(it.hold, "");
    const first = it.run();
    await waitFor(() => it.startCount() === 1, "the first copy to open the tool", undefined, { during: first.result });
    const second = it.run();
    expect(await second.exited).toBe(1);
    expect(await sessionState(it.dir)).toBe("running");
    rmSync(it.hold);
    expect(await first.exited).toBe(0);
    expect(it.startCount()).toBe(1);
    // The gone copy's lock stays as it was, and so does this copy's, taken over after it, for the next copy to take over after this one.
    expect(readFileSync(join(it.dir, "lock"), "utf8")).toStartWith("pid=");
    expect(readdirSync(it.dir).filter((name) => !name.startsWith("open.")).sort()).toEqual(["lock", expect.stringMatching(/^lock\.after\.pid_\d+_started_/), "status"]);
  }, 30_000);

  it("opens the app once when four copies start together on a lock left by a copy that is gone", async () => {
    const it = await launcher();
    await goneCopysLock(it.dir);
    const bin = join(it.root, "barrier");
    mkdirSync(bin);
    const release = join(bin, "release");
    const finished = join(bin, "finished");
    const gap = join(bin, "gap");
    const starts = join(it.root, "starts");
    const lock = join(it.dir, "lock");
    // Each cat reads the real lock before waiting: all four copies see the same dead owner,
    // regardless of how the system schedules them after the barrier opens.
    it.releaseOnClose(release); it.releaseOnClose(finished);
    const realCat = Bun.which("cat")!, realMv = Bun.which("mv")!;
    const command = `const child = Bun.spawn([program, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(await child.exited);`;
    it.program(join(bin, "cat"), `
const fs = require("node:fs"), args = process.argv.slice(2), program = ${JSON.stringify(realCat)};
const copy = process.env.TAKEOVER_TEST_COPY;
const record = ${JSON.stringify(bin)} + "/record." + copy;
if (args[0] === ${JSON.stringify(lock)} && !fs.existsSync(${JSON.stringify(bin)} + "/read." + copy)) {
  const child = Bun.spawn([program, ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) process.exit(code);
  fs.writeFileSync(record, text);
  fs.writeFileSync(${JSON.stringify(bin)} + "/read." + copy, "");
  while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
  args.splice(0, args.length, record);
}
${command}
`);
    // The old implementation moved the live lock before claiming it. Force exactly that gap.
    it.program(join(bin, "mv"), `
const fs = require("node:fs"), args = process.argv.slice(2), program = ${JSON.stringify(realMv)};
const copy = process.env.TAKEOVER_TEST_COPY;
if (args[0] === "-f" && args[1] === ${JSON.stringify(lock)}) {
  const finished = () => fs.existsSync(${JSON.stringify(finished)});
  if (copy === "2") while ((!fs.existsSync(${JSON.stringify(starts)}) || fs.statSync(${JSON.stringify(starts)}).size === 0) && !finished()) await Bun.sleep(10);
  if (copy === "3") while (!fs.existsSync(${JSON.stringify(gap)}) && !finished()) await Bun.sleep(10);
  if (copy === "4") while (!finished()) await Bun.sleep(10);
  const child = Bun.spawn([program, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (copy === "2" && code === 0) { fs.writeFileSync(${JSON.stringify(gap)}, ""); while (!finished()) await Bun.sleep(10); }
  process.exit(code);
}
${command}
`);
    writeFileSync(it.hold, "");
    const copies = Array.from({ length: 4 }, (_, index) => it.run({ PATH: `${bin}:${process.env.PATH}`, TAKEOVER_TEST_COPY: String(index + 1) }));
    const codes: (number | undefined)[] = [];
    const exits = copies.map((copy, index) => copy.exited.then((code) => (codes[index] = code)));
    try {
      await waitFor(() => copies.every((_, index) => existsSync(join(bin, `read.${index + 1}`))), "all four copies to read the dead owner's lock", undefined, { during: Promise.all(exits) });
      writeFileSync(release, "");
      await waitFor(() => it.startCount() > 1 || (it.startCount() === 1 && codes.filter((code) => code === 1).length === 3), "one app and three refusals, or the old launcher's second app", undefined, { during: Promise.all(exits) });
      expect(it.startCount()).toBe(1);
      expect(codes.filter((code) => code === 1)).toHaveLength(3);
      expect(await sessionState(it.dir)).toBe("running");
    } finally {
      // Release every gate and close the fake apps even if an assertion fails against the old launcher.
      writeFileSync(release, "");
      writeFileSync(finished, "");
      rmSync(it.hold, { force: true });
      await Promise.all(exits);
    }
    expect([...codes].sort()).toEqual([0, 1, 1, 1]);
    for (const [index, copy] of copies.entries()) if (codes[index] === 1) expect(await copy.stdout).toContain("Codex is already open in your terminal for this task. Use that window.");
    expect(it.startCount()).toBe(1);
  });

  /**
   * A copy slow to check whether the copy holding the lock is still running: its ps, while the gate
   * names the process it is asked about, notes that it is waiting and waits for the gate to go.
   */
  function slowCheck(owner: TerminalLauncher) {
    const bin = join(owner.root, "slow");
    mkdirSync(bin, { recursive: true });
    const gate = join(owner.root, "gate"), waiting = join(owner.root, "waiting");
    owner.removeOnClose(gate);
    owner.program(join(bin, "ps"), `
const fs = require("node:fs"), args = process.argv.slice(2);
if (fs.existsSync(${JSON.stringify(gate)}) && fs.readFileSync(${JSON.stringify(gate)}, "utf8").trim() === args[3]) {
  fs.writeFileSync(${JSON.stringify(waiting)}, "");
  while (fs.existsSync(${JSON.stringify(gate)})) await Bun.sleep(50);
}
const child = Bun.spawn([${JSON.stringify(Bun.which("ps"))}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`);
    return { env: { PATH: `${bin}:${process.env.PATH}` }, gate, waiting };
  }

  for (const [what, gone] of [
    ["from no lock", false],
    ["from a lock left by a copy that is gone", true],
  ] as const)
    it(`refuses a copy slow to check on the open app once that app has closed and another copy opened it again, ${what}`, async () => {
      const it = await launcher();
      if (gone) await goneCopysLock(it.dir);
      writeFileSync(it.hold, "");
      const first = it.run();
      await waitFor(() => it.startCount() === 1, "the first copy to open the tool", undefined, { during: first.result });
      const firstPid = Number(readdirSync(it.dir).find((name) => name.startsWith("run."))!.slice(4));
      // The late copy finds the first one holding the lock, and is held while it checks that it still runs.
      const slow = slowCheck(it);
      writeFileSync(slow.gate, String(firstPid));
      const late = it.run(slow.env);
      await waitFor(() => existsSync(slow.waiting), "the late copy to check on the first one", undefined, { during: late.result });
      // Meanwhile the app closes, and another copy opens it again.
      it.stopTool(it.toolPids()[0]!);
      await first.exited;
      const next = it.run();
      await waitFor(() => it.startCount() === 2, "the next copy to open the tool", undefined, { during: next.result });
      rmSync(slow.gate);
      const stopped = late.exited.then(() => true);
      await waitFor(async () => it.startCount() > 2 || (await Promise.race([stopped, Bun.sleep(10).then(() => false)])), "the late copy to stop or open the tool");
      expect(it.startCount()).toBe(2);
      expect(await late.exited).toBe(1);
      expect(await late.stdout).toContain("Codex is already open in your terminal for this task. Use that window.");
      expect(await sessionState(it.dir)).toBe("running");
      rmSync(it.hold);
      expect(await next.exited).toBe(0);
      expect(it.startCount()).toBe(2);
    }, 60_000);

  it("notes the end when the terminal window is closed", async () => {
    const it = await launcher();
    writeFileSync(it.hold, "");
    const copy = it.run();
    // Running, and holding the lock: the window's close is now this copy's to note.
    await waitFor(async () => (await sessionState(it.dir)) === "running" && readdirSync(it.dir).includes("lock"), "the copy to start", undefined, { during: copy.result });
    copy.signal("SIGHUP");
    rmSync(it.hold);
    await copy.exited;
    expect(await sessionState(it.dir)).toBe("ended");
    expect(readFileSync(join(it.dir, "status"), "utf8")).toContain("state=ended");
  }, 30_000);
});
