import { commandText, type CheckRun } from "@petrina/core";
import { ValidationRun } from "../../src/validation-run.js";
import type { ValidationRecord, ValidationRunEffects, ValidationRunHost } from "../../src/ports/validation-run.js";
import { observedCheck } from "./check-repairs.js";
import { waitDuring } from "./clock.js";

export type ValidationPhase = "inspection" | "copy" | "log" | "command";
export type ValidationSavePhase = "admission" | "start evidence" | "log registration";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

/** Scripted adapter observations, never native execution evidence or a SQLite implementation. */
export function validationRunFixture(options: { holdAt?: ValidationPhase; fail?: { phase: ValidationSavePhase; count: number };
  cleanup?: boolean; result?: CheckRun | null } = {}) {
  const record: ValidationRecord = { id: "validation", requestId: "request", taskId: "task", productId: "product", productName: "Private product",
    repository: "fixture/product", source: "supplied-source", name: "Supplied check", reason: "Controller observation", image: "fixture:ready", argv: ["check", "literal argument"],
    commit: "a".repeat(40), tree: "b".repeat(40), versionNote: "Saved version only", workingEdits: false,
    host: { system: "supplied", arch: "supplied" }, containerName: "fixture-validation", owner: "fixture", snapshot: "supplied-copy",
    state: "queued", queuedAt: 100, queueOrder: 7 };
  const original = structuredClone(record), calls: string[] = [], notes: string[] = [];
  const decisions: { kind: "finish" | "hold" | "requeue"; record: ValidationRecord; detail?: string }[] = [];
  const released = deferred(), stop = new AbortController();
  let entered = false, closed = false, now = 200, remaining = options.fail?.count ?? 0, injected = false, logOpen = false;
  let work: Promise<void> | undefined;
  const bound = (value: ValidationRecord) => { if (value !== record) throw new Error("Validation effects received another request"); };
  const phase = async (value: ValidationPhase) => { calls.push(value); if (options.holdAt === value) { entered = true; await released.promise; } };
  const failure = new Error(`${options.fail?.phase} disk unavailable`);
  const fail = () => { remaining--; injected = true; throw failure; };
  const host: ValidationRunHost = {
    now: () => now++,
    admissionClosed: taskId => { if (taskId !== record.taskId) throw new Error("Admission was read for another task"); return closed; },
    persist() {
      calls.push("persist");
      if (remaining && (injected ? record.result === "not run" : options.fail?.phase === "admission" ? record.state === "preparing" && !record.container
        : options.fail?.phase === "log registration" && record.state === "running" && !!record.run)) fail();
    },
    change(value, apply) {
      bound(value); calls.push("change");
      const previous = structuredClone(record), notices = notes.length;
      try { return apply(); }
      catch (error) {
        for (const key of Object.keys(record)) Reflect.deleteProperty(record, key);
        Object.assign(record, previous); notes.splice(notices); throw error;
      }
    },
    note(value, kind) {
      bound(value); notes.push(kind);
      if (remaining && !injected && options.fail?.phase === "start evidence" && kind === "started") fail();
    },
    finish(value, result, detail) { bound(value); decisions.push({ kind: "finish", record: structuredClone(record), detail }); if (record.result !== result) throw new Error("Completion contradicted its recorded result"); },
    requeue(value) { bound(value); decisions.push({ kind: "requeue", record: structuredClone(record) }); },
    hold(value, detail) { bound(value); decisions.push({ kind: "hold", record: structuredClone(record), detail }); },
  };
  const effects: ValidationRunEffects = {
    async prepare(value) { bound(value); await phase("inspection"); return { tool: "supplied", endpoint: "supplied", service: "supplied", imageId: "supplied", os: "linux", arch: "supplied" }; },
    async snapshot(value) { bound(value); await phase("copy"); },
    async run(value, signal, callbacks) {
      bound(value); if (signal !== stop.signal) throw new Error("Command lost its request signal");
      logOpen = true;
      try {
        await phase("log");
        if (!callbacks.admitted()) return undefined;
        callbacks.log({ logPath: "supplied-log", logFileIdentity: { device: "supplied", inode: "supplied" }, logFileLength: 0, logFileBeginning: "supplied" });
        if (options.result === null) return undefined;
        callbacks.spawned(123);
        await phase("command");
        return options.result ?? { ...observedCheck(0), name: record.name, command: commandText(record.argv), startedAt: 300, endedAt: 320, ms: 20 };
      } finally { logOpen = false; calls.push("log closed"); }
    },
    async cleanup(value) { bound(value); if (logOpen) throw new Error("Cleanup began before the command adapter settled its diagnostic"); calls.push("cleanup"); return options.cleanup ?? true; },
  };
  const controller = new ValidationRun(host, effects);
  return { record, original, calls, notes, decisions,
    get entered() {
      if (!work) throw new Error("Start validation before observing its phase");
      return waitDuring(() => entered, work, `the owned validation ${options.holdAt} phase`);
    },
    release: () => released.resolve(), failure, stop,
    closeAdmission: () => { closed = true; }, remaining: () => remaining,
    run: () => work ??= Promise.resolve().then(() => controller.execute(record, stop.signal)),
    close: async () => { stop.abort("fixture"); released.resolve(); await work; },
  };
}
