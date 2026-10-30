import { registerFixtureRoot } from "./fixture-retention.js";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { processList } from "@petrina/platform/process-tree";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { FixtureOperations } from "./fixture-operations.js";
import { createProcessLease, type ProcessLease } from "./process-lease.js";
import { CLEANUP_MS } from "./command-budgets.js";
import { tempDir, waitFor } from "./fixtures.js";
import { removeFixtureRoot } from "./fixture-roots.js";
import { currentSlow } from "./slow.js";

export interface DefunctProcess {
  readonly root: string;
  readonly pid: number;
  readonly holderPid: number;
  readonly self: string;
  /** Stop actors only; joining the surrounding body here would deadlock manual release. */
  release(): Promise<void>;
}
export interface NodeSignalReceipt {
  paused: boolean;
  continued: boolean;
  signal: string | null;
  outputClosed: boolean;
}
type Outcome<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown };
type Receipt = { kind: string; pid?: number } & Partial<NodeSignalReceipt>;
const arm = (fire: () => void, ms: number) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/** Publish case ownership before asynchronous setup; no ownerless acquisition is exported. */
export function defunctProcesses() {
  const active = new Set<{ seal(): void; close(): Promise<void> }>();
  const retained = new Set<string>();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void;
    let failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      done = resolve;
      failed = reject;
    });
    const entries = [...active];
    for (const entry of entries) entry.seal();
    void Promise.allSettled(
      entries.map(async (entry) => {
        await entry.close();
      }),
    ).then((results) => {
      closing = undefined;
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length) {
        failed(new AggregateError(errors, "Defunct fixture cleanup was not confirmed; roots retained"));
      } else {
        done();
      }
    });
    return closing;
  };
  const use = async <T>(
    mode: "defunct" | "signals",
    body: (fixture: DefunctProcess | NodeSignalReceipt) => Promise<T>,
    beforeRead?: (holderPid: number) => void,
  ): Promise<T> => {
    if (closing) throw new Error("Defunct fixtures are closing; no case may start");
    if (process.platform === "win32") {
      throw new Error("Defunct processes are a POSIX-only boundary; use Windows termination controls on Windows.");
    }
    const node = Bun.which("node");
    if (!node) throw new Error("The native process fixture requires the repository's declared Node.js prerequisite");
    const root = tempDir("petrina-defunct-");
    const deadlines = { allowanceMs: CLEANUP_MS * currentSlow(), arm };
    registerFixtureRoot(root);
    let accepting = true;
    let lease: ProcessLease | undefined;
    let child: ChildProcess | undefined;
    let native: Promise<void> | undefined;
    const records = new Map<string, Receipt>();
    const actors = new FixtureOperations({
      ...deadlines,
      label: `Defunct actors at ${root}`,
      async stop() {
        accepting = false;
        const results = await Promise.allSettled([
          (async () => {
            await lease?.close();
          })(),
          (async () => {
            child?.stdin?.end();
            if (native) await native;
          })(),
        ]);
        const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (errors.length) throw new AggregateError(errors, "Defunct actors could not all settle");
      },
      dispose() {},
    });
    const owner = new FixtureOperations({
      ...deadlines,
      label: `Defunct fixture at ${root}`,
      stop: () => actors.close(),
      dispose: () => removeFixtureRoot(root),
    });
    let observed = false;
    const entry = {
      seal() {
        accepting = false;
      },
      close() {
        accepting = false;
        const result = owner.close();
        if (!observed) {
          observed = true;
          void result.then(
            () => active.delete(entry),
            () => {
              active.delete(entry);
              retained.add(root);
            },
          );
        }
        return result;
      },
    };
    active.add(entry);
    if (closing) {
      await entry.close();
      throw new Error("Defunct collection closed during case construction");
    }
    const release = () => {
      accepting = false;
      return actors.close();
    };
    const work = owner.run(async (): Promise<Outcome<T>> => {
      try {
        if (mode === "defunct") {
          lease = await actors.run(() => createProcessLease());
          if (!accepting) {
            await lease.close();
            throw new Error("Defunct lease completed after admission closed");
          }
          const targetSource =
            'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n' +
            lease.program('process.stdout.write("ready\\n"); await new Promise(() => {});');
          writeFileSync(join(root, "target.mjs"), targetSource);
        }
        if (!accepting) throw new Error("Defunct fixture closed before native setup");
        const program = join(root, "owner.mjs");
        writeFileSync(program, nodeProgram(root, mode, deadlines.allowanceMs));
        const running = actors.run(async () => {
          if (!accepting) throw new Error("Defunct fixture closed before native launch");
          const actual = (child = spawn(node, [program], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }));
          let output = "";
          let stderr = "";
          let out = false;
          let err = false;
          let failure: { error: unknown } | undefined;
          native = new Promise<void>((resolve, reject) => {
            actual.once("error", (error) => {
              failure ??= { error };
            });
            actual.stdin!.on("error", (error) => {
              failure ??= { error };
            });
            actual.stdout!.on("data", (chunk) => {
              output += chunk.toString("utf8");
              if (output.length > 65_536) {
                failure ??= { error: new Error("Defunct helper protocol exceeded its bound") };
                actual.stdin?.end();
                return;
              }
              for (let end; (end = output.indexOf("\n")) >= 0; ) {
                const line = output.slice(0, end);
                output = output.slice(end + 1);
                try {
                  const receipt = JSON.parse(line) as Receipt;
                  if (!receipt || typeof receipt.kind !== "string") {
                    throw new Error("Invalid defunct helper record");
                  }
                  records.set(receipt.kind, receipt);
                } catch (error) {
                  failure ??= { error };
                  actual.stdin?.end();
                }
              }
            });
            actual.stdout!.once("end", () => {
              out = true;
            });
            actual.stderr!.on("data", (chunk) => {
              stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
            });
            actual.stderr!.once("end", () => {
              err = true;
            });
            for (const stream of [actual.stdout!, actual.stderr!]) {
              stream.once("error", (error) => {
                failure ??= { error };
              });
            }
            actual.once("close", (code, signal) => {
              if (failure) reject(failure.error);
              else if (!out || !err) reject(new Error("Defunct helper output did not confirm EOF"));
              else if (code !== 0 || signal !== null) {
                reject(new Error(`Defunct helper failed (${code ?? signal}): ${stderr}`));
              } else resolve();
            });
          });
          void native.catch(() => undefined);
          if (!accepting) actual.stdin?.end();
          await native;
        });
        void running.catch(() => undefined);
        if (mode === "signals") {
          const receipt = await waitFor(
            () => records.get("signals"),
            "the owned native Node signal boundary",
            undefined,
            { during: running },
          );
          await running;
          return { kind: "value", value: await body(receipt as NodeSignalReceipt) };
        }
        const holder = await waitFor(() => records.get("holder"), "the owned holder", 5_000, { during: running });
        if (!Number.isSafeInteger(holder.pid) || holder.pid! <= 0) {
          throw new Error("The actual holder identity was not reported");
        }
        beforeRead?.(holder.pid!);
        const target = await waitFor(
          () => records.get("target"),
          "the owned child's complete process record",
          5_000,
          { during: running },
        );
        if (!Number.isSafeInteger(target.pid) || target.pid! <= 0) {
          throw new Error("The actual target identity was not reported");
        }
        if (!accepting) throw new Error("Defunct fixture closed before its pause");
        child!.stdin!.write("pause\n");
        await waitFor(
          async () => {
            const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], 4_000 * currentSlow());
            const rows = list?.split("\n").map((line) => line.trim().split(/\s+/));
            const parent = rows?.find(([id]) => Number(id) === holder.pid);
            const own = rows?.find(([id]) => Number(id) === target.pid);
            return parent?.[3]?.startsWith("T") && own && Number(own[1]) === holder.pid && Number(own[2]) === target.pid;
          },
          "the actual holder to pause before its child ends",
          10_000,
          { during: running },
        );
        await lease!.close();
        const self = await waitFor(
          async () => {
            const list = await processList(["-A", "-o", "pid=,pgid=,stat="], 4_000 * currentSlow());
            const rows = list?.split("\n").map((line) => line.trim().split(/\s+/));
            const isDefunct = rows?.some(
              ([id, group, state]) =>
                Number(id) === target.pid && Number(group) === target.pid && state?.startsWith("Z"),
            );
            return isDefunct ? rows?.find(([id]) => Number(id) === process.pid)?.join(" ") : undefined;
          },
          "the real process and group to remain defunct",
          10_000,
          { during: running },
        );
        return {
          kind: "value",
          value: await body({ root, pid: target.pid!, holderPid: holder.pid!, self, release }),
        };
      } catch (error) {
        return { kind: "error", error };
      }
    });
    const result = await work;
    try {
      await entry.close();
    } catch (cleanup) {
      if (result.kind === "error") {
        throw new AggregateError([result.error, cleanup], "Defunct body and cleanup failed");
      }
      throw cleanup;
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  };
  return {
    retained,
    close,
    use: <T>(
      body: (fixture: DefunctProcess) => Promise<T>,
      options: { beforeRead?(holderPid: number): void } = {},
    ) => use("defunct", (fixture) => body(fixture as DefunctProcess), options.beforeRead),
    checkSignals: () => use("signals", async (fixture) => fixture as NodeSignalReceipt),
  };
}

/** Standard Node owns each live child; receipts never grant signalling authority. */
function nodeProgram(root: string, mode: "defunct" | "signals", budget: number): string {
  const signalActorScript =
    'process.on("SIGCONT", () => process.stdout.write("continued\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';
  return `import { spawn, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.versions.bun) throw new Error("The paused process fixture requires native Node.js");
const stopOwnedProcess = (${stopOwnedProcess.toString()});
const arm = (fire, ms) => { const timer = setTimeout(fire, ms); return () => clearTimeout(timer); };
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const observe = child => {
  let output = "", errors = "", failure, out = false, err = false;
  const lines = new Map(), changes = new Set();
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => Number.isInteger(code) ? resolve(code) : reject(new Error("Owned helper ended by " + signal)));
    child.once("error", reject);
  });
  void exited.catch(() => {});
  const closed = new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      for (let end; (end = output.indexOf("\\n")) >= 0;) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        lines.set(line, true);
        for (const changed of [...changes]) changed();
      }
    });
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-65536); });
    child.stdout.once("end", () => { out = true; });
    child.stderr.once("end", () => { err = true; });
    for (const stream of [child.stdout, child.stderr]) stream.once("error", error => { failure = { error }; });
    child.once("error", error => { failure = { error }; });
    child.stdin?.on("error", error => { failure = { error }; });
    child.once("close", (code, signal) =>
      failure
        ? reject(failure.error)
        : out && err
          ? resolve({ code, signal, errors })
          : reject(new Error("Owned helper output EOF unavailable")),
    );
  });
  void closed.catch(() => {});
  return { child, lines, changes, exited, closed, get outputClosed() { return out && err; } };
};
const wait = (check, owner) => {
  if (check()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (failed, error, ready) => {
      if (done) return;
      done = true;
      owner.changes.delete(changed);
      failed ? reject(error) : resolve(ready);
    };
    const changed = () => { if (check()) finish(false, undefined, true); };
    owner.changes.add(changed);
    void owner.closed.then(
      observation =>
        check()
          ? finish(false, undefined, true)
          : closed
            ? finish(false, undefined, false)
            : finish(true, new Error("Owned helper ended before readiness (" + observation.code + "): " + observation.errors)),
      error => finish(true, error),
    );
    changed();
  });
};
let current, closing, paused = false, closed = false;
const finish = () => {
  if (closing) return closing;
  closed = true;
  let done, failed;
  closing = new Promise((resolve, reject) => { done = resolve; failed = reject; });
  void (async () => {
    if (!current) return;
    const child = current.child;
    if (${JSON.stringify(mode)} === "signals") {
      const handle = {
        exited: current.exited,
        get exitCode() { return child.exitCode; },
        get signalCode() { return child.signalCode; },
        kill: signal => child.kill(signal),
      };
      const stopped = await stopOwnedProcess(handle, { graceMs: 1000, forceMs: 1000 }, arm);
      if (stopped !== "confirmed") throw new Error("Native signal actor cleanup was not confirmed");
    } else {
      if (paused && child.exitCode === null && child.signalCode === null && !child.kill("SIGCONT")) {
        throw new Error("The owned holder could not resume");
      }
      child.stdin.end();
    }
    const ended = await current.closed;
    if (${JSON.stringify(mode)} === "defunct" && ended.code !== 0) {
      throw new Error("Holder failed to collect its child: " + ended.errors);
    }
  })().then(done, failed);
  void closing.catch(() => {});
  return closing;
};
let input = "";
process.stdin.on("data", chunk => {
  input += chunk.toString();
  for (let end; (end = input.indexOf("\\n")) >= 0;) {
    const request = input.slice(0, end);
    input = input.slice(end + 1);
    if (request !== "pause" || closed || !current || ${JSON.stringify(mode)} !== "defunct") {
      void finish();
      continue;
    }
    paused = true;
    if (!current.child.kill("SIGSTOP")) {
      console.error("The owned holder could not pause");
      void finish();
    }
  }
});
process.stdin.once("end", () => { void finish(); });
process.stdin.once("error", () => { void finish(); });
try {
  if (${JSON.stringify(mode)} === "signals") {
    const actor = current = observe(
      spawn(process.execPath, ["-e", ${JSON.stringify(signalActorScript)}], { stdio: ["pipe", "pipe", "pipe"] }),
    );
    const ready = await wait(() => actor.lines.has("ready"), actor);
    if (ready && !closed) {
      if (!actor.child.kill("SIGSTOP")) throw new Error("Native Node STOP was rejected");
      const state = await new Promise((resolve, reject) =>
        execFile(
          "ps",
          ["-o", "stat=", "-p", String(actor.child.pid)],
          { timeout: ${budget}, windowsHide: true },
          (error, text) => error ? reject(error) : resolve(text.trim()),
        ),
      );
      if (!state.startsWith("T")) throw new Error("Native actor did not become paused");
      if (closed) throw new Error("Signal owner closed before native CONT");
      if (!actor.child.kill("SIGCONT")) throw new Error("Native Node CONT was rejected");
      const continued = await wait(() => actor.lines.has("continued"), actor);
      if (!continued || closed) throw new Error("Native CONT was not observed before owner closure");
      actor.child.kill("SIGKILL");
      const ended = await actor.closed;
      send({ kind: "signals", paused: true, continued: true, signal: ended.signal, outputClosed: actor.outputClosed });
    }
  } else {
    const holder = ${JSON.stringify(join(root, "holder.mjs"))};
    writeFileSync(holder, ${JSON.stringify(holderProgram(root))});
    if (closed) throw new Error("Defunct owner closed before holder launch");
    current = observe(spawn(process.execPath, [holder], { stdio: ["pipe", "pipe", "pipe"] }));
    send({ kind: "holder", pid: current.child.pid });
    const ready = await wait(() => current.lines.has("ready"), current);
    if (ready && !closed) {
      const identity = [...current.lines.keys()].find(line => line.startsWith("target:"));
      if (!identity) throw new Error("Holder did not report its real target");
      send({ kind: "target", pid: Number(identity.slice(7)) });
      await new Promise((resolve, reject) => {
        const joined = () => { void finish().then(resolve, reject); };
        if (closed) joined();
        else {
          process.stdin.once("end", joined);
          process.stdin.once("error", joined);
        }
      });
    }
  }
} finally {
  try { await finish(); }
  finally { process.stdin.destroy(); }
}
`;
}

function holderProgram(root: string): string {
  return `import { spawn } from "node:child_process";
const stopOwnedProcess = (${stopOwnedProcess.toString()});
const arm = (fire, ms) => { const timer = setTimeout(fire, ms); return () => clearTimeout(timer); };
let child, closed = false, stopping, exited, complete;
const finish = () => {
  closed = true;
  if (stopping) return stopping;
  let done, failed;
  stopping = new Promise((resolve, reject) => { done = resolve; failed = reject; });
  void (async () => {
    if (!child) return;
    const handle = {
      exited,
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      kill: signal => child.kill(signal),
    };
    const stopped = await stopOwnedProcess(handle, { graceMs: 1000, forceMs: 1000 }, arm);
    if (stopped !== "confirmed") throw new Error("The native target did not confirm termination");
    await complete;
  })().then(done, failed);
  void stopping.catch(() => {});
  return stopping;
};
process.stdin.once("end", () => { void finish().catch(error => { console.error(error); process.exitCode = 1; }); });
process.stdin.once("error", () => { void finish().catch(error => { console.error(error); process.exitCode = 1; }); });
process.stdin.resume();
try {
  if (!closed) {
    child = spawn(process.execPath, [${JSON.stringify(join(root, "target.mjs"))}], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", out = false, err = false, failure, reported = false;
    exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => Number.isInteger(code) ? resolve(code) : reject(new Error("Target ended by " + signal)));
      child.once("error", reject);
    });
    void exited.catch(() => {});
    complete = new Promise((resolve, reject) => {
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (!reported && output.includes("ready\\n")) {
          reported = true;
          process.stdout.write("target:" + child.pid + "\\nready\\n");
        }
      });
      child.stdout.once("end", () => { out = true; });
      child.stderr.resume();
      child.stderr.once("end", () => { err = true; });
      child.once("error", error => { failure = { error }; });
      for (const stream of [child.stdout, child.stderr]) stream.once("error", error => { failure = { error }; });
      child.once("close", () =>
        failure
          ? reject(failure.error)
          : out && err
            ? resolve()
            : reject(new Error("Target output EOF unavailable")),
      );
    });
    void complete.catch(() => {});
    await new Promise((resolve, reject) => {
      const joined = () => { void finish().then(resolve, reject); };
      if (closed) joined();
      else {
        process.stdin.once("end", joined);
        process.stdin.once("error", joined);
      }
    });
  }
} finally {
  try { await finish(); }
  finally { process.stdin.destroy(); }
}
`;
}
