import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { runCommand, startCommand, CLEANUP_MS, type Started } from "@petrina/test-support/commands";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { tempDir, waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { stopOwnedProcess, type OwnedProcess } from "@petrina/platform/owned-process";
import { childState } from "@petrina/platform/process-tree";
import { checkOwner, checkStartCapture } from "./check-execution.js";
import { runChecks } from "./check-runner.js";

type CheckArguments = Parameters<typeof runChecks> extends [string, ...infer Rest] ? Rest : never;
const arm = (expired: () => void, ms: number) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };

/** Native check worlds delegate admission, settlement and disposal to the existing check owner. */
export function checkProcessFixtures() {
  const owners = new Set<ReturnType<typeof checkOwner>>();
  let closing = false;
  function open(prefix: string) {
    if (closing) throw new Error("The check-process fixture collection is closing");
    const dir = tempDir(prefix), controller = new AbortController();
    const captures = new Set<ReturnType<typeof checkStartCapture>>(), handles = new Set<OwnedProcess>();
    const restorers: (() => void)[] = [], independentStops: (() => void | Promise<void>)[] = [], actors = new Set<string>();
    let lease: ProcessLease | undefined, acquiringLease: Promise<ProcessLease> | undefined;
    const owner = checkOwner(dir, async () => {
      const errors: unknown[] = [];
      const settle = async (work: readonly (() => unknown | Promise<unknown>)[]) => {
        const outcomes = await Promise.allSettled(work.map(start => Promise.resolve().then(start)));
        for (const outcome of outcomes) if (outcome.status === "rejected") errors.push(outcome.reason);
      };
      controller.abort();
      await settle([...restorers, ...[...captures].map(capture => () => capture.restore()), () => lease?.close(), ...independentStops]);
      for (const capture of captures) for (const child of capture.children()) handles.add(child);
      await settle([...handles].map(child => async () => {
        if (await stopOwnedProcess(child, { graceMs: CLEANUP_MS * SLOW, forceMs: CLEANUP_MS * SLOW }, arm) !== "confirmed")
          throw new Error("An actual check-process fixture handle did not stop");
      }));
      // Records authorize observation only. No saved process number is ever signalled.
      if ([...captures].some(capture => capture.children().length)) await settle([...actors].map(path => async () => {
        if (!existsSync(path)) throw new Error(`The leased check actor has no complete identity record: ${path}`);
        const text = readFileSync(path, "utf8"), value: unknown = text.trim().startsWith("{") ? JSON.parse(text) : Number(text);
        const pid = typeof value === "number" ? value : value && typeof value === "object" && "pid" in value ? value.pid : undefined;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(`The leased check actor's identity is invalid: ${path}`);
        await waitFor(async () => await childState(pid) === "ended", "the independently leased native actor to end", CLEANUP_MS * SLOW);
      }));
      if (errors.length) throw new AggregateError(errors, `Native check fixture cleanup is unconfirmed; retained ${dir}`);
    });
    owners.add(owner);
    const close = async () => { await owner.close(); owners.delete(owner); };
    const leased = () => acquiringLease ??= owner.run(async () => {
      lease = await createProcessLease();
      // Closing may have begun during acquisition, before the stop callback could see the lease.
      if (!owner.beforeStart()) await lease.close();
      return lease;
    });
    return { dir, close, run: owner.run,
      children: () => [...captures].flatMap(capture => capture.children()),
      restore(restore: () => void) { restorers.push(restore); },
      stop(stop: () => void | Promise<void>) { independentStops.push(stop); },
      observeActor(path: string) { actors.add(path); return path; },
      lease: leased,
      program(body: string, name: string) {
        const record = join(dir, name);
        return owner.run(async () => {
          const lease = await leased(), json = import.meta.resolve("@petrina/test-support/fixture-json");
          return lease.program(`const { writeFixtureJson } = await import(${JSON.stringify(json)}); writeFixtureJson(${JSON.stringify(record)}, { pid: process.pid }); ${body}`);
        });
      },
      async sentinel(): Promise<Started> {
        let child: Started | undefined;
        const running = owner.run(async () => {
          const lease = await leased();
          if (!owner.beforeStart()) throw new Error("The native sentinel fixture is closing");
          return runCommand([process.execPath, "-e", lease.program("await new Promise(() => setInterval(() => {}, 1000));")], {
            timeoutMs: 60_000 * SLOW,
            start(argv, options) { child = startCommand(argv, options); handles.add(child); return child; },
          });
        });
        await waitFor(() => child, "the unrelated native sentinel's actual handle", undefined, { during: running });
        return child!;
      },
      checks(...[checks, env, timeout, signal, logs, processes, progress, records, onSpawn, onLog, beforeStart]: CheckArguments) {
        return owner.run(async () => {
          const commands = checks.map(check => check.argv), capture = checkStartCapture(dir, commands[0] ?? [], commands.slice(1));
          captures.add(capture); capture.install();
          try {
            return await runChecks(dir, checks, env, timeout, signal ?? controller.signal, logs, processes, progress, records, onSpawn, onLog,
              () => owner.beforeStart() && (beforeStart?.() ?? true));
          } finally { capture.restore(); }
        });
      },
    };
  }
  async function use<T>(prefix: string, work: (fixture: ReturnType<typeof open>) => Promise<T>): Promise<T> {
    const fixture = open(prefix);
    const result = await setupWithCleanup(() => fixture.run(() => work(fixture)), fixture.close);
    await fixture.close();
    return result;
  }
  async function close() {
    closing = true;
    const settled = await Promise.allSettled([...owners].map(owner => owner.close()));
    const failed = settled.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Native check fixture owners could not all close");
    owners.clear();
  }
  return { use, close };
}
