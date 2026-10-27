import { timerObservation } from "../../fixtures/timer-observations.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecordFixtures } from "../../fixtures/coordinator-records.js";
const owners = coordinatorRecordFixtures();
afterAll(() => owners.close());

it("contains a step-clock save failure and lets the next clock checkpoint save again", async () => {
  return owners.use(async ({ engine, task, owner: lifetime }) => {

  task.stepClock = { roleId: "builder", repeat: false, worked: 0, since: Date.now() };
  lifetime.check();
    const save = spyOn(engine, "save");
    lifetime.onStop(() => save.mockRestore());
    save.mockImplementationOnce(() => { throw new Error("Disk unavailable"); });
  lifetime.check();
    const log = spyOn(console, "error");
    lifetime.onStop(() => log.mockRestore());
    log.mockImplementation(() => {});
  try {
    expect(() => engine["checkpointStepTimes"]()).not.toThrow();
    expect(log).toHaveBeenCalledWith("Could not save step times:", expect.objectContaining({ message: "Disk unavailable" }));
    expect(() => engine["checkpointStepTimes"]()).not.toThrow();
    expect(save).toHaveBeenCalledTimes(2);
    expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.stepClock).toBeDefined();
  } finally { save.mockRestore(); log.mockRestore(); await engine.shutdown(); }
  });
});

it("registers the periodic step-clock checkpoint separately from other 15-second timers", async () => {
  return owners.useRoot("petrina-clock-registration-", async ({ root }) => {
    const observation = await timerObservation(root, "registration");
    expect(observation.checkpointCalls).toBe(1);
  });
});

it("checkpoints step times only while a clock is active and the engine is running", async () => {
  return owners.use(async ({ engine, task, owner: lifetime }) => {

  lifetime.check();
    const save = spyOn(engine, "save");
    lifetime.onStop(() => save.mockRestore());
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
});
