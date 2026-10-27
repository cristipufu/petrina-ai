import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecordFixtures } from "../../fixtures/coordinator-records.js";
const owners = coordinatorRecordFixtures();
afterAll(() => owners.close());

it("waits for background work to settle without replaying an owner's handled rejection", async () => {
  return owners.use(async ({ engine, owner: lifetime }) => {

  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const success = new Promise<string>(resolve => { finish = resolve; });
  const failure = new Promise<never>((_, reject) => { fail = reject; });
  const reason = new Error("A follow-up picture is still on the original task");
  const handled = failure.catch(error => error);
  lifetime.onStop(() => { finish("Copied"); fail(reason); });
  try {
    expect(engine.trackWork(success)).toBe(success);
    expect(engine.trackWork(failure)).toBe(failure);
    expect(engine.backgroundWork.size).toBe(2);
    expect(engine.inFlight()).toBe(2);
    let settled = false;
    const waiting = Promise.all([...engine.backgroundWork]).then(() => { settled = true; });
    finish("Copied");
    expect(await success).toBe("Copied");
    expect(engine.backgroundWork.size).toBe(1);
    expect(engine.inFlight()).toBe(1);
    expect(settled).toBe(false);
    fail(reason);
    await waiting;
    expect(await handled).toBe(reason);
    expect(settled).toBe(true);
    expect(engine.backgroundWork.size).toBe(0);
    expect(engine.inFlight()).toBe(0);
  } finally {
    finish("Copied"); fail(reason);
    await Promise.allSettled([...engine.backgroundWork]);
    await engine.shutdown();
  }
  });
});

it("handles and logs rejected PR polls while keeping the background work registry drainable", async () => {
  return owners.use(async ({ engine, owner: lifetime }) => {

  lifetime.check();
    const poll = spyOn(engine["shipping"].monitor, "pollPullRequests");
    lifetime.onStop(() => poll.mockRestore());
    poll.mockRejectedValue(new Error("Database unavailable"));
  lifetime.check();
    const log = spyOn(console, "error");
    lifetime.onStop(() => log.mockRestore());
    log.mockImplementation(() => {});
  try {
    engine["pollPullRequests"]();
    await Promise.allSettled([...engine.backgroundWork]);
    expect(log).toHaveBeenCalledWith("Could not refresh pull requests:", expect.objectContaining({ message: "Database unavailable" }));
    expect(engine.backgroundWork.size).toBe(0);
    poll.mockResolvedValue(); engine["pollPullRequests"](); await Promise.all([...engine.backgroundWork]);
  } finally { poll.mockRestore(); log.mockRestore(); await engine.shutdown(); }
  });
});
