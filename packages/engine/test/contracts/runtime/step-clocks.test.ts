import { timerObservation } from "../../fixtures/timer-observations.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecords } from "../../fixtures/coordinator-records.js";
import { removeDir, tempDir } from "../../fixtures.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const fixture = () => coordinatorRecords(roots);

it("contains a step-clock save failure and lets the next clock checkpoint save again", async () => {
  const { engine, task } = await fixture();
  task.stepClock = { roleId: "builder", repeat: false, worked: 0, since: Date.now() };
  const save = spyOn(engine, "save").mockImplementationOnce(() => { throw new Error("Disk unavailable"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => engine["checkpointStepTimes"]()).not.toThrow();
    expect(log).toHaveBeenCalledWith("Could not save step times:", expect.objectContaining({ message: "Disk unavailable" }));
    expect(() => engine["checkpointStepTimes"]()).not.toThrow();
    expect(save).toHaveBeenCalledTimes(2);
    expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.stepClock).toBeDefined();
  } finally { save.mockRestore(); log.mockRestore(); await engine.shutdown(); }
});

it("registers the periodic step-clock checkpoint separately from other 15-second timers", async () => {
  const root = tempDir("petrina-clock-registration-"); roots.push(root);
  const observation = await timerObservation(root, "registration");
  expect(observation.checkpointCalls).toBe(1);
});

it("checkpoints step times only while a clock is active and the engine is running", async () => {
  const { engine, task } = await fixture();
  const save = spyOn(engine, "save");
  try {
    engine["checkpointStepTimes"](); expect(save).not.toHaveBeenCalled();
    task.stepClock = { roleId: "builder", repeat: false, worked: 0, since: Date.now() };
    engine["checkpointStepTimes"](); expect(save).toHaveBeenCalledTimes(1);
    delete task.stepClock.since;
    engine["checkpointStepTimes"](); expect(save).toHaveBeenCalledTimes(1);
    await engine.shutdown(); save.mockClear();
    engine["checkpointStepTimes"](); expect(save).not.toHaveBeenCalled();
  } finally { save.mockRestore(); await engine.shutdown(); }
});
