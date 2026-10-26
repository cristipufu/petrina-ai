import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../../src/acp-run.js";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { tempDir, removeDir, waitFor } from "@petrina/test-support/fixtures";
import { lstatSync } from "node:fs";

type Options = Parameters<typeof AgentRun.start>[0];
type SimpleAgent = Pick<Options, "profile" | "callbacks" | "onProcess" | "onGone"> & { stubborn?: boolean };
type Outcome = { run: AgentRun } | { error: unknown };
const arm = (expired: () => void, ms: number) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };

/** Native no-fork ACP peers only; the actual public stop result stays independent of fixture cleanup. */
export function stoppingActors() {
  const active = new Set<{ seal(): void; close(): Promise<void> }>(), retained = new Set<string>();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const entries = [...active];
    for (const entry of entries) entry.seal();
    void Promise.allSettled(entries.map(entry => entry.close())).then(results => {
      closing = undefined;
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) reject(new AggregateError(errors, "Stopping fixtures retained unconfirmed native ownership"));
      else resolve();
    });
    return closing;
  };
  return { close, retained,
    async use<T>(body: (fixture: { root: string; agent(controller: AbortController, options: SimpleAgent): Promise<AgentRun> }) => Promise<T>): Promise<T> {
      if (closing) throw new Error("Stopping fixtures are closing; no case may open");
      const root = tempDir("petrina-stopping-owned-"), starts: { controller: AbortController; outcome: Promise<Outcome> }[] = [];
      const children: { child: ChildProcess; exited: Promise<number>; closed: Promise<void>; readonly outputClosed: boolean }[] = [];
      let lease: ProcessLease | undefined, accepting = true;
      const owner = new FixtureOperations({ label: `Stopping fixture at ${root}`, allowanceMs: CLEANUP_MS * SLOW, arm,
        async stop() {
          accepting = false;
          for (const start of starts) start.controller.abort();
          // Request independent cleanup before joining startup or the subject's stop promise.
          const cleanup = Promise.allSettled([
            (async () => { await lease?.close(); })(),
            ...children.map(async record => {
              const stopped = await stopOwnedProcess({
                exited: record.exited,
                get exitCode() { return record.child.exitCode; }, get signalCode() { return record.child.signalCode; },
                kill: signal => record.child.kill(signal),
              }, { graceMs: 1_000, forceMs: 1_000 }, arm);
              if (stopped !== "confirmed") throw new Error("The actual no-fork peer did not confirm termination");
              await waitFor(() => record.outputClosed,
                "the actual ACP peer's owned output to end", CLEANUP_MS, { during: record.closed });
            }),
          ]);
          const domains = await Promise.allSettled(starts.map(async start => {
            const result = await start.outcome;
            if ("run" in result) await result.run.stop();
          }));
          const errors = [...domains, ...await cleanup].flatMap(result => result.status === "rejected" ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, "Stopping fixture cleanup was not confirmed");
        },
        dispose() {
          removeDir(root);
          try { lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          throw new Error("The stopped ACP fixture root could not be removed");
        },
      });
      let observed = false;
      const entry = { seal() { accepting = false; }, close: () => {
        accepting = false;
        const result = owner.close();
        if (!observed) { observed = true; void result.then(() => { active.delete(entry); }, () => { active.delete(entry); retained.add(root); }); }
        return result;
      } };
      active.add(entry);
      const agent = (controller: AbortController, options: SimpleAgent): Promise<AgentRun> => {
        if (!accepting) return Promise.reject(new Error("Stopping fixture is closed; no peer may start"));
        if (starts.length) return Promise.reject(new Error("Each stopping fixture owns exactly one no-fork ACP peer"));
        let completed!: (result: Outcome) => void;
        const outcome = new Promise<Outcome>(resolve => { completed = resolve; });
        starts.push({ controller, outcome });
        const opening = owner.run(async () => {
          if (!lease) lease = await createProcessLease();
          if (!accepting) { await lease.close(); throw new Error("Stopping fixture lease completed after admission closed"); }
          const program = join(root, `peer-${starts.length}.ts`);
          const original = join(import.meta.dir, "session-agent.ts");
          writeFileSync(program, lease.program(`process.argv[1] = ${JSON.stringify(original)}; ${options.stubborn ? 'process.argv.push("--stubborn");' : ""} await import(${JSON.stringify(original)}); await new Promise(() => undefined);`));
          return AgentRun.start({ profile: options.profile, callbacks: options.callbacks, signal: controller.signal, cwd: root,
            command: [process.execPath, program], browser: false,
            onGone(gone) { void gone.catch(() => undefined); options.onGone?.(gone); },
            onProcess(child) {
              const exited = new Promise<number>((resolve, reject) => {
                child.once("exit", (code, signal) => Number.isInteger(code) ? resolve(code!) : reject(new Error(`The native peer ended by ${signal}`)));
                child.once("error", reject);
                if (child.exitCode !== null) resolve(child.exitCode);
                else if (child.signalCode !== null) reject(new Error(`The native peer ended by ${child.signalCode}`));
              });
              let outputClosed = false;
              const closed = new Promise<void>((resolve, reject) => { child.once("close", () => { outputClosed = true; resolve(); }); child.once("error", reject); });
              void exited.catch(() => undefined); void closed.catch(() => undefined);
              children.push({ child, exited, closed, get outputClosed() { return outputClosed; } });
              options.onProcess?.(child);
            },
          });
        });
        void opening.then(run => completed({ run }), error => completed({ error }));
        return opening;
      };
      const result = await setupWithCleanup(() => owner.run(() => body({ root, agent })), () => entry.close());
      await entry.close();
      return result;
    },
  };
}
