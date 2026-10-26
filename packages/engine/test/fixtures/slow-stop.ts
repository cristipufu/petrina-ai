import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { runCommand } from "@petrina/test-support/commands";
import { shutdownActors } from "./shutdown-actors.js";
import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fakes, HARNESS, type EngineProcesses } from "../support.js";
import { ENGINE_TEST_ROOT } from "./runtime-paths.js";

/** Native stop/read-deadline contract recipe. POSIX group and defunct semantics are deliberately confined here. */
export async function slowStopFixture(dir: string, owners: EngineProcesses, stubborn: boolean, killFirst: boolean, native: boolean) {
    const actors = await shutdownActors(dir);
    return setupWithCleanup(async () => {
    if (owners.signal.aborted) throw new Error("Slow-stop fixture preparation was stopped");
    const home = join(dir, "data");
    const fakes = new Fakes(join(dir, "fake"));
    const hold = join(dir, "hold");
    const slow = join(dir, "slow");
    const scanned = join(dir, "scanned"), recover = join(dir, "recover");
    const killed = join(dir, "killed");
    const buildPids = join(dir, "build-pids");
    const snapshot = join(dir, "process-list");
    const finalLists = join(dir, "final-lists");
    const stops = join(dir, "stops");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // The first delayed/killed helper is real. Recovery and final confirmation use scripted
    // reads in the engine, without starting another helper inside a shrinking read allowance.
    // The separate native case covers real discovery, pausing and stopping with no injected delay.
    // Recovery belongs to the next invocation, even if the first helper never runs its TERM trap.
    writeFileSync(join(bin, "ps"), `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (existsSync(${JSON.stringify(slow)})) {
  let listed;
  try { listed = readFileSync(${JSON.stringify(snapshot)}, "utf8"); } catch { process.exit(1); }
  let first = false;
  try { writeFileSync(${JSON.stringify(scanned)}, "", { flag: "wx" }); first = true; } catch {}
  if (!first) writeFileSync(${JSON.stringify(recover)}, "");
  if (${killFirst} && first) { await Bun.sleep(3000); writeFileSync(${JSON.stringify(killed)}, ""); process.kill(process.pid, "SIGKILL"); }
  await Bun.sleep(first ? ${stubborn ? "3900" : "1100"} : 100);
  process.stdout.write(listed); process.exit(0);
}
const ps = Bun.spawnSync(["/bin/ps", ...process.argv.slice(2)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
process.exit(ps.exitCode);
`);
    chmodSync(join(bin, "ps"), 0o755);
    // Complete the Mac's first run of this fresh stand-in before measuring the stop deadline.
    const readiness = (argv: readonly string[], output: "stdout" | "stderr") => owners.prepare(() => runCommand(argv, { signal: owners.signal,
      start: (args, settings) => {
        const child = Bun.spawn(args, { detached: settings.detached, stdout: output === "stdout" ? "pipe" : "ignore", stderr: output === "stderr" ? "pipe" : "ignore" });
        return { pid: child.pid, exited: child.exited, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
          ...(child.stdout ? { stdout: child.stdout } : {}), ...(child.stderr ? { stderr: child.stderr } : {}), kill: signal => child.kill(signal) };
      },
    }));
    const ready = await readiness([join(bin, "ps"), "-A", "-o", "pid=,ppid="], "stderr");
    expect(ready.code, ready.stderr).toBe(0);
    if (!native) {
      // Unavailable scripted data is a failed read, never a successful empty process list.
      writeFileSync(slow, "");
      const absent = await readiness([join(bin, "ps"), "-A", "-o", "pid=,ppid=,stat="], "stdout");
      expect(absent.code).toBe(1);
      expect(absent.stdout).toBe("");
      expect(existsSync(scanned)).toBe(false);
      rmSync(slow);
    }
    const launcher = join(dir, "engine.ts");
    writeFileSync(launcher, `import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
${native ? "" : `import * as processes from "node:child_process";
import { spyOn } from "bun:test";
import { finishedHelper, runCommand } from ${JSON.stringify(join(ENGINE_TEST_ROOT, "fixtures.ts"))};
// Before the timed stop, read the engine's inherited group for complete final snapshots.
const ownGroup = Number((await runCommand(["/bin/ps", "-o", "pgid=", "-p", String(process.pid)])).stdout.trim());
if (!ownGroup) throw new Error("Could not read the fixture engine's process group");
process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;
const kill = process.kill.bind(process), paused = new Set(), owners = new Map(), agents = new Set(), forced = new Set();
const live = pid => { try { kill(pid, 0); return true; } catch { return false; } };
const listing = groups => [
  { pid: process.pid, parent: process.ppid, group: ownGroup },
  // The agent and its detached workers each lead their own process group.
  ...[...owners].map(([pid, parent]) => ({ pid, parent, group: pid })),
].filter(({ pid }) => live(pid) || (${killFirst} && agents.has(pid) && forced.has(pid))).map(({ pid, parent, group }) =>
  pid + " " + (groups ? group : parent) + " " + (forced.has(pid) ? "Z" : paused.has(pid) ? "T" : "S")).join("\\n") + "\\n";
const publish = () => {
  writeFileSync(${JSON.stringify(snapshot + ".tmp")}, listing(false));
  renameSync(${JSON.stringify(snapshot + ".tmp")}, ${JSON.stringify(snapshot)});
};
// Scripted states follow successful real signals to this fixture's known processes.
// Native late-fork tests and the native case below check the actual OS pause barrier.
process.kill = function(pid, signal) {
  // The killed-helper case also keeps a forced agent's number present until collection.
  // Only the final process-group snapshot can then confirm its completed stop.
  if (${killFirst} && signal === 0 && agents.has(Math.abs(pid)) && forced.has(Math.abs(pid))) return true;
  const result = kill(pid, signal);
  if (signal === "SIGKILL" && owners.has(Math.abs(pid)) && existsSync(${JSON.stringify(slow)})) forced.add(Math.abs(pid));
  if (signal === "SIGSTOP" && agents.has(Math.abs(pid)) && existsSync(${JSON.stringify(slow)}) && existsSync(${JSON.stringify(buildPids)})) {
    const workers = readFileSync(${JSON.stringify(buildPids)}, "utf8").split("\\n").map(Number).filter(pid => pid > 0 && live(pid));
    for (const worker of workers) owners.set(worker, Math.abs(pid));
  }
  if (signal === "SIGSTOP") paused.add(Math.abs(pid));
  if (signal === "SIGCONT") paused.delete(Math.abs(pid));
  if (signal === "SIGSTOP" || signal === "SIGCONT") publish();
  return result;
};
const original = processes.execFile;
spyOn(processes, "execFile").mockImplementation((...args) => {
  if (args[0] !== "ps" || !existsSync(${JSON.stringify(slow)}) || !existsSync(${JSON.stringify(scanned)})) return Reflect.apply(original, processes, args);
  const groups = args[1].some(arg => arg.includes("pgid="));
  const listed = listing(groups), timeout = args[2].timeout, done = args.at(-1);
  writeFileSync(${JSON.stringify(recover)}, "");
  if (groups) appendFileSync(${JSON.stringify(finalLists)}, JSON.stringify(listed) + "\\n");
  setTimeout(() => done(timeout <= 100 ? new Error("Process list timed out") : null, timeout <= 100 ? "" : listed, ""), Math.min(100, timeout));
  return finishedHelper();
});`}
const { AgentRun, AGENT_CLEANUP_NOTE } = await import(${JSON.stringify(join(ENGINE_TEST_ROOT, "../../agent-runtime/src/acp-run.ts"))});
const start = AgentRun.start;
AgentRun.start = function(options) {
  return start.call(this, { ...options, command: [options.command[0], ${JSON.stringify(actors.actor)}, ...options.command.slice(2)], callbacks: { ...options.callbacks, onLog(text) {
    if (text.includes(AGENT_CLEANUP_NOTE)) console.error(text.trim());
    options.callbacks.onLog?.(text);
  } }, ${native ? "" : `onProcess(child) {
    agents.add(child.pid); owners.set(child.pid, process.pid); publish();
    options.onProcess?.(child);
  }`} });
};
const stop = AgentRun.prototype.stop;
const observed = new WeakSet();
AgentRun.prototype.stop = function(...args) {
  const started = Date.now(), pending = stop.apply(this, args);
  if (!observed.has(this)) {
    observed.add(this);
    void pending.then(
      complete => {
        const evidence = { pid: this.child.pid, elapsed: Date.now() - started, complete };
        appendFileSync(${JSON.stringify(stops)}, JSON.stringify(evidence) + "\\n");
        console.info("Agent stop evidence:", JSON.stringify(evidence));
      },
      error => console.error("Agent stop error:", JSON.stringify({ pid: this.child.pid, elapsed: Date.now() - started, error: String(error) })),
    );
  }
  return pending;
};
await import(${JSON.stringify(HARNESS)});`);
    writeFileSync(hold, "");
    writeFileSync(join(fakes.dir, "agents.json"), JSON.stringify({ hold: { title: "Long build", file: hold }, background: { title: "Long build", pids: buildPids, program: actors.background } }));
    if (owners.signal.aborted) throw new Error("Slow-stop fixture preparation was stopped");
    return { dir, actors, home, fakes, hold, slow, scanned, recover, killed, buildPids, finalLists, stops, launcher };
    }, () => actors.close());
}
