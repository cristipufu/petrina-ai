// A real command completes; the parent kills this engine at a synchronous SQLite checkpoint boundary.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ExtraValidation } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";

const [data, settings, marker, phase, storage] = process.argv.slice(2);
if (!data || !settings || !marker) throw new Error("A private checkpoint fixture is required");
const options = JSON.parse(readFileSync(settings, "utf8")) as EngineOptions;
const engine = new Engine(data, { ...options, agentCommand: () => { throw new Error("Checkpoint controls must not start agents"); }, awakeObserver: () => {} });
const extra = engine.extraValidations;
let late = false;
const pause = (record: ExtraValidation) => {
  writeFileSync(marker + ".tmp", JSON.stringify(record)); renameSync(marker + ".tmp", marker);
  // No busy loop: bound this child independently and stop if its parent disappears.
  const parent = process.ppid, until = Date.now() + 45_000;
  const latch = new Int32Array(new SharedArrayBuffer(4));
  while (process.ppid === parent && Date.now() < until) Atomics.wait(latch, 0, 0, 25);
  process.exit(82);
};
const note = extra["note"].bind(extra);
extra["note"] = (record, kind, words) => {
  if (kind === "stopping") {
    if (storage === "archive") {
      const saved = engine.store.loadActive()!;
      engine.store.save({ ...saved, tasks: saved.tasks.map(task => task.id === record.taskId ? { ...task, state: "cancelled" } : task) }, [record.taskId]);
      engine.s.tasks = engine.s.tasks.filter(task => task.id !== record.taskId);
    }
    // Select only the late-write branch, retaining the last committed running snapshot.
    // Real shutdown/work-log/Tester sequencing has its separate workflow controls.
    engine.stopped = true; late = true;
  }
  note(record, kind, words);
};
const ownership = engine.store.saveExtraValidationOwnership.bind(engine.store);
engine.store.saveExtraValidationOwnership = (...args) => {
  if (late && phase === "inside") pause(engine.s.extraValidations![0]!);
  ownership(...args);
};
const persist = extra["persist"].bind(extra);
extra["persist"] = () => {
  persist();
  if (late && phase === "checkpoint") pause(engine.s.extraValidations![0]!);
};
const finish = extra["finish"].bind(extra);
extra["finish"] = (record, result, detail) => {
  finish(record, result, detail);
  if (late && phase === "finished") pause(record);
};
engine.setPoolPaused(false);
await new Promise(() => {});
