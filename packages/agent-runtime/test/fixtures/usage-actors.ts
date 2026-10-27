import type { ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { waitFor } from "@petrina/test-support/fixtures";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { stopOwnedProcess } from "@petrina/platform/owned-process";

const arm = (expired: () => void, ms: number) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };

/** Existing private provider protocols with independent leases and actual child/output ownership. */
export function usageActors() {
  const active = new Set<{ close(): Promise<void> }>(), roots = new Set<string>(), retained = new Set<string>();
  async function use<T>(root: string, body: (fixture: {
    signal: AbortSignal; command(argv: readonly string[]): Promise<readonly string[]>; observe(child: ChildProcess): void;
    run<T>(start: () => Promise<T>): Promise<T>; inspect<T, R>(start: () => Promise<T>, inspect: (raw: Promise<T>) => Promise<R>): Promise<R>;
  }) => Promise<T>): Promise<T> {
    registerFixtureRoot(root); roots.add(root);
    const controller = new AbortController();
    let lease: ProcessLease | undefined, sequence = 0, accepting = true;
    const children: { child: ChildProcess; exited: Promise<number>; closed: Promise<void>; ended(): boolean; noChild(): boolean }[] = [];
    const owner = new FixtureOperations({ label: `Account fixture at ${root}`, allowanceMs: CLEANUP_MS * SLOW, arm,
      async stop() {
        accepting = false; controller.abort();
        const pending = Promise.allSettled([Promise.resolve().then(() => lease?.close()), ...children.map(async record => {
          const stopped = record.noChild() ? "confirmed" : await stopOwnedProcess({ exited: record.exited,
            get exitCode() { return record.child.exitCode; }, get signalCode() { return record.child.signalCode; }, kill: signal => record.child.kill(signal),
          }, { graceMs: 1_000, forceMs: 1_000 }, arm);
          if (stopped !== "confirmed") throw new Error("The actual account peer did not confirm termination");
          await waitFor(record.ended, "the actual account peer's output to close", CLEANUP_MS, { during: record.closed });
        })]);
        const results = await pending, errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Account fixture cleanup was not confirmed");
      }, dispose() {
        removeFixtureRoot(root);
      },
    });
    const entry = { close() {
      accepting = false; const stopped = owner.close();
      void stopped.then(() => active.delete(entry), () => { active.delete(entry); retained.add(root); }); return stopped;
    } }; active.add(entry);
    const observe = (child: ChildProcess) => {
      let ended = false, started = child.pid !== undefined, failedStart = false;
      const exited = new Promise<number>((resolve, reject) => {
        child.once("spawn", () => { started = true; });
        child.once("exit", code => Number.isInteger(code) ? resolve(code!) : reject(new Error("Account peer ended by signal")));
        child.once("error", error => { failedStart = !started; reject(error); });
        if (child.exitCode !== null) resolve(child.exitCode);
      });
      const closed = new Promise<void>(resolve => child.once("close", () => { ended = true; resolve(); }));
      void exited.catch(() => undefined);
      children.push({ child, exited, closed, ended: () => ended, noChild: () => failedStart && !started && ended });
      if (!accepting) child.kill("SIGKILL");
    };
    return setupWithCleanup(() => owner.run(async () => {
      const command = (argv: readonly string[]) => owner.run(async () => {
        if (!accepting) throw new Error("Account fixture is closing");
        if (!lease) lease = await createProcessLease();
        if (!accepting) { await lease.close(); throw new Error("Account lease completed after close"); }
        // Missing executable cases retain their exact native startup failure.
        if (argv[0] !== process.execPath || argv[1] !== "-e" && !existsSync(argv[1]!)) return argv;
        const file = join(root, `owned-account-${++sequence}.ts`);
        const source = argv[1] === "-e" ? argv[2]! : `process.argv = ${JSON.stringify([process.execPath, ...argv.slice(1)])}; await import(${JSON.stringify(argv[1])});`;
        writeFileSync(file, lease.program(`${source}\nawait new Promise(() => undefined);`)); return [process.execPath, file];
      });
      return body({ signal: controller.signal, command, observe,
        run: start => owner.run(start),
        inspect: (start, inspect) => owner.run(async () => {
          const raw = Promise.resolve().then(start), checked = Promise.resolve().then(() => inspect(raw));
          const results = await Promise.allSettled([raw, checked]);
          const result = results[1]!; if (result.status === "rejected") throw result.reason; return result.value;
        }),
      });
    }), () => entry.close()).then(async result => { await entry.close(); return result; });
  }
  return { use, retained, owns: (root: string) => roots.has(root), async close() {
    const results = await Promise.allSettled([...active].map(entry => entry.close()));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Account fixture roots retained");
  } };
}
