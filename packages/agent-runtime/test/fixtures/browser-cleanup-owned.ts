import { spyOn } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../../src/acp-run.js";
import { AgentBrowser } from "../../src/browser.js";
import { ENGINE_PROFILES } from "../../src/tools.js";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { tempDir, testBrowserRoot, waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { nativeSession } from "./native-session.js";

type Result<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown };
const observe = <T>(work: Promise<T>): Promise<Result<T>> => work.then(value => ({ kind: "value", value }), error => ({ kind: "error", error }));
const arm = (expired: () => void, ms: number) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };
function captured(child: ChildProcess) {
  const exited = new Promise<number>((resolve, reject) => {
    child.once("exit", (code, signal) => code === null ? reject(new Error(`Owned helper ended by ${signal}`)) : resolve(code));
    child.once("error", reject);
  });
  let closed = false;
  const closing = new Promise<void>((resolve, reject) => { child.once("close", () => { closed = true; resolve(); }); child.once("error", reject); });
  void exited.catch(() => undefined); void closing.catch(() => undefined);
  return { child, exited, closing, get ended() { return child.exitCode !== null || child.signalCode !== null; },
    get drained() { return closed && child.stdout?.readableEnded === true && child.stderr?.readableEnded === true; } };
}

/** Intentional SDK failures never replace independent native-handle and browser-folder cleanup. */
export function browserCleanupFixtures() {
  const active = new Set<{ close(): Promise<void> }>();
  return {
    async close() {
      const results = await Promise.allSettled([...active].map(entry => entry.close()));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Browser cleanup fixtures retain native resources");
    },
    async use<T>(body: (fixture: {
      root: string; registry: string; logs: string[]; readonly browser: AgentBrowser | undefined;
      readonly gone: Promise<void> | undefined; readonly incomplete: number; readonly events: readonly string[];
      open(options?: { browser?: true; probe?: boolean; onGone?(gone: Promise<void>): void; onProcess?(child: ChildProcess): void }): Promise<Result<AgentRun>>;
      ended(): Promise<void>; restoreScans(): void;
    }) => Promise<T>): Promise<T> {
      const root = tempDir("petrina-browser-cleanup-owned-"); registerFixtureRoot(root);
      const browsers = testBrowserRoot(); registerFixtureRoot(browsers);
      const registry = join(root, "registry"), controller = new AbortController(), logs: string[] = [], events: string[] = [];
      const children: ReturnType<typeof captured>[] = [], openings: Promise<Result<AgentRun>>[] = [];
      let lease: ProcessLease | undefined, browser: AgentBrowser | undefined, gone: Promise<void> | undefined;
      let accepting = true, unavailable = true, incomplete = 0, opening = false;
      let started: ReturnType<typeof spyOn<typeof AgentBrowser, "start">> | undefined;
      const owner = new FixtureOperations({ label: `Browser cleanup fixture at ${root}`, allowanceMs: CLEANUP_MS * SLOW, arm,
        async stop() {
          accepting = false; unavailable = false; controller.abort();
          const errors: unknown[] = [];
          // The admitted forwarding call retains its closure; no later opening may use this spy.
          try { started?.mockRestore(); } catch (error) { errors.push(error); }
          // Independent requests precede any join of the deliberately failing subject.
          const physical = Promise.allSettled([
            (async () => { await lease?.close(); })(),
            (async () => { await browser?.close(); })(),
            ...children.map(async record => {
              const stopped = await stopOwnedProcess({ exited: record.exited,
                get exitCode() { return record.child.exitCode; }, get signalCode() { return record.child.signalCode; },
                kill: signal => record.child.kill(signal),
              }, { graceMs: 1_000, forceMs: 1_000 }, arm);
              if (stopped !== "confirmed") throw new Error("Actual helper termination is unconfirmed");
              await waitFor(() => record.drained, "the actual owned helper's output to drain", CLEANUP_MS, { during: record.closing });
            }),
          ]);
          const domains = await Promise.allSettled(openings.map(async work => {
            const result = await work;
            if (result.kind === "value") await result.value.stop();
          }));
          const results = [...domains, ...await physical];
          errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
          // A late browser has its handle captured before birth is exposed. Join its positive
          // folder cleanup too; a historic false AgentRun.stop never grants disposal authority.
          try { await browser?.close(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, "Independent browser cleanup was not confirmed");
        },
        dispose() { removeFixtureRoot(browsers); removeFixtureRoot(root); },
      });
      let closeObserved = false;
      const entry = { close() {
        accepting = false;
        const work = owner.close();
        // Terminal failures remain journalled; they are not replayed against the next case.
        if (!closeObserved) { closeObserved = true; void work.then(() => active.delete(entry), () => active.delete(entry)); }
        return work;
      } };
      active.add(entry);
      const close = () => entry.close();
      return setupWithCleanup(async () => {
        await owner.run(async () => {
          lease = await createProcessLease();
          if (!accepting) { await lease.close(); throw new Error("Browser fixture closed during lease setup"); }
        });
        const peer = nativeSession(root), program = join(root, "leased-peer.ts");
        writeFileSync(program, lease!.program(`await import(${JSON.stringify(peer.command[1])}); await new Promise(() => undefined);`));
        const fixture = { root, registry, logs, get browser() { return browser; }, get gone() { return gone; },
          get incomplete() { return incomplete; }, get events() { return events; }, restoreScans() { unavailable = false; },
          async ended() {
            for (const record of children) await waitFor(() => record.ended && record.drained,
              "the actual helper to terminate and drain", CLEANUP_MS, { during: record.closing });
          },
          open(options: { browser?: true; probe?: boolean; onGone?(gone: Promise<void>): void; onProcess?(child: ChildProcess): void } = {}) {
            if (!accepting || opening) return Promise.reject(new Error("Fixture admits exactly one native opening"));
            opening = true;
            if (options.browser) {
              const original = AgentBrowser.start;
              started = spyOn(AgentBrowser, "start");
              started.mockImplementation(async (...args) => {
                browser = await original.call(AgentBrowser, args[0], args[1], args[2], args[3], {
                  ...browserProcesses, readFolder: directory => unavailable ? Promise.resolve(undefined) : browserProcesses.readFolder(directory),
                }, { launch(directory, secret, parent, env) {
                  if (!accepting) throw new Error("Fixture closed before browser helper admission");
                  const child = spawn(process.execPath, [join(import.meta.dir, "../../src/browser-server.ts"), directory, secret, String(parent)], {
                    cwd: join(import.meta.dir, "../../src"), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
                  });
                  children.push(captured(child)); return child;
                } });
                if (!accepting) { await browser.close(); throw new Error("Browser finished startup after fixture close"); }
                const record = children.find(record => record.child === browser!["child"])!;
                record.child.kill("SIGKILL");
                await waitFor(() => record.ended && record.drained, "the actual unused browser helper's output to close", CLEANUP_MS, { during: record.closing });
                return browser;
              });
            }
            const work = owner.run(() => observe(AgentRun.start({
              profile: ENGINE_PROFILES.find(profile => profile.toolId === "claude-code")!, cwd: root,
              command: [process.execPath, program, ...peer.command.slice(2)], signal: controller.signal,
              browser: options.browser === true, ...(options.browser ? { browserRoot: registry, browserTempRoot: browsers } : {}),
              ...(options.probe !== undefined ? { probe: options.probe } : {}),
              callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny",
                onLog: text => logs.push(text), onCleanupIncomplete: () => { incomplete++; } },
              onGone(value) { gone = value; events.push("gone"); void value.catch(() => undefined); options.onGone?.(value); },
              onProcess(child) { children.push(captured(child)); events.push("process"); options.onProcess?.(child); },
            })));
            openings.push(work); return work;
          },
        };
        const value = await owner.run(() => body(fixture));
        await close(); return value;
      }, close);
    },
  };
}
