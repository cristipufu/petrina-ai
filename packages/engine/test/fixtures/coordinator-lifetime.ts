import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure } from "@petrina/test-support/commands";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { waitFor } from "@petrina/test-support/fixtures";
import { EngineProcess, HARNESS, FAKE_AGENT } from "../support.js";
import { coordinatorProcess, type CoordinatorProcess } from "./coordinator-process.js";
import { pidsIn } from "./shutdown-actors.js";
import { processAlive } from "../../src/instance.js";

/** Private ownership survives actual restart/reparenting; saved process numbers never authorize a signal. */
export async function coordinatorLifetime(root: string) {
  const lease = await createProcessLease(), pids = join(root, "coordinator-actors");
  const apps: EngineProcess[] = [], commands: CoordinatorProcess[] = [];
  let closing: Promise<void> | undefined;
  const uncertainStarts: unknown[] = [];
  const unconfirmed = (error: unknown): boolean => error instanceof CommandFailure ? error.cleanup === "unconfirmed" : error instanceof Error && error.cause !== undefined ? unconfirmed(error.cause) : false;
  const program = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, lease.program(`require("node:fs").appendFileSync(${JSON.stringify(pids)}, String(process.pid) + "\\n");\n${body}\nawait new Promise(() => undefined);`));
    return path;
  };
  let entry: string, actor: string;
  try {
    entry = program("coordinator-engine.ts", `await import(${JSON.stringify(HARNESS)});`);
    actor = program("coordinator-agent.ts", `await import(${JSON.stringify(FAKE_AGENT)});`);
  } catch (error) {
    try { await lease.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Coordinator program preparation failed and lease cleanup was not confirmed"); }
    throw error;
  }
  return { actor, entry, program,
    start(home: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}, options: { input?: "pipe" | "ignore" } = {}) {
      const command = coordinatorProcess(home, argv, env, options); commands.push(command); return command;
    },
    async app(home: string, argv: readonly string[]) {
      try { const app = await EngineProcess.start(home, argv); apps.push(app); return app; }
      catch (error) { if (unconfirmed(error)) uncertainStarts.push(error); throw error; }
    },
    async harness(home: string, dir: string, remote?: string, extra: readonly string[] = []) {
      try {
        const app = await EngineProcess.start(home, [entry, home, dir, ...(remote ? [remote] : []), `--agent-program=${actor}`, ...extra]);
        apps.push(app); return app;
      } catch (error) { if (unconfirmed(error)) uncertainStarts.push(error); throw error; }
    },
    close() { return closing ??= (async () => {
      const errors: unknown[] = [...uncertainStarts];
      try { await lease.close(); } catch (error) { errors.push(error); }
      // The native command handles are independently owned. A saved marker/connection PID is observation only.
      const settled = await Promise.allSettled([
        ...commands.map(command => command.settle()),
        ...apps.map(app => app.settleAfterStop()),
      ]);
      for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
      try { await waitFor(() => !pidsIn(pids).some(processAlive), "all independently owned coordinator wrappers to exit", 5_000); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Coordinator fixture cleanup could not be confirmed");
    })(); },
  };
}
export type CoordinatorLifetime = Awaited<ReturnType<typeof coordinatorLifetime>>;

/** Cases release ownership independently; cleanup uncertainty keeps that root out of ordinary file removal. */
export function coordinatorLifetimes() {
  const current: { root: string; lifetime: CoordinatorLifetime }[] = [], retained = new Set<string>();
  return { retained,
    async open(root: string) { const lifetime = await coordinatorLifetime(root); current.push({ root, lifetime }); return lifetime; },
    async close() {
      const settled = await Promise.allSettled(current.splice(0).map(async ({ root, lifetime }) => {
        try { await lifetime.close(); } catch (error) { retained.add(root); throw error; }
      }));
      const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Coordinator cases retained unconfirmed native ownership");
    },
  };
}
