import { expect, it, spyOn } from "bun:test";
import { checkExecutionFixture } from "../../fixtures/check-execution.js";
import { childState } from "@petrina/platform/process-tree";

it("settles the native check and both acquired readers after a read failure", async () => {
  const owner = await checkExecutionFixture("read-error");
  try {
    const [run] = await owner.run();
    expect(run!.ok).toBe(false);
    expect(run!.execution).toMatchObject({ started: true, stdout: "read-error", failure: { kind: "read", message: "Controlled native reader failure" }, cleanup: "confirmed", outputCleanup: "confirmed" });
    expect(run!.cleanupIncomplete).toBeUndefined();
    expect(owner.child()!.stdout.locked).toBe(false);
    expect(owner.child()!.stderr.locked).toBe(false);
    expect(await childState(owner.child()!.pid)).toBe("ended");
  } finally { await owner.close(); }
});

it("still acquires and closes the other pipe when one reader is already locked", async () => {
  const owner = await checkExecutionFixture("locked-output");
  try {
    const [run] = await owner.run();
    expect(run!.ok).toBe(false);
    expect(run!.execution).toMatchObject({ started: true, stdout: "read-error", failure: { kind: "read" }, outputCleanup: "unconfirmed" });
    expect(run!.cleanupIncomplete).toBe(true);
    expect(owner.child()!.stdout.locked).toBe(true);
    expect(owner.child()!.stderr.locked).toBe(false);
  } finally { await owner.close(); }
});

it("does not accept a logical reader closure caused by a rejected cancellation", async () => {
  const owner = await checkExecutionFixture("cancel-error");
  try {
    const [run] = await owner.run();
    expect(owner.cancelledReaderClosed()).toBe(true);
    expect(run!.ok).toBe(false);
    expect(run!.execution).toMatchObject({ stdout: "read-error", cleanup: "confirmed", outputCleanup: "unconfirmed" });
    expect(run!.cleanupIncomplete).toBe(true);
    expect(owner.child()!.stdout.locked).toBe(false);
    expect(owner.child()!.stderr.locked).toBe(false);
  } finally { await owner.close(); }
});

it("recognizes an independently errored stream before attempting its cancellation", async () => {
  const owner = await checkExecutionFixture("errored-output");
  try {
    const [run] = await owner.run();
    expect(run!.ok).toBe(false);
    expect(run!.execution).toMatchObject({ stdout: "read-error", failure: { kind: "read", message: "Independently failed output" }, cleanup: "confirmed", outputCleanup: "confirmed" });
    expect(run!.cleanupIncomplete).toBeUndefined();
    expect(owner.child()!.stderr.locked).toBe(false);
  } finally { await owner.close(); }
});

it("bounds typed observation errors without changing failure or cleanup facts", async () => {
  const owner = await checkExecutionFixture("plain");
  try {
    const [run] = await owner.run(undefined, false, () => { throw new Error(`${"large observation ".repeat(2_000)}actual registration failure`); });
    expect(run!.ok).toBe(false);
    expect(run!.execution?.failure?.kind).toBe("observer");
    expect(run!.execution!.failure!.message.length).toBeLessThanOrEqual(6_002);
    expect(run!.execution!.failure!.message).toEndWith("actual registration failure");
    expect(run!.execution?.cleanup).toBe("confirmed");
    expect(run!.execution?.outputCleanup).toBe("confirmed");
  } finally { await owner.close(); }
});

it("refuses an actual zero exit with an inherited pipe still held and never signals its collected identity", async () => {
  const owner = await checkExecutionFixture("held-output"), signals: number[] = [];
  const nativeKill = process.kill.bind(process);
  const signalling = spyOn(process, "kill").mockImplementation((pid, signal) => {
    const leader = owner.child()?.pid;
    if (signal !== undefined && signal !== 0 && leader !== undefined && (pid === leader || pid === -leader)) { signals.push(pid); throw new Error("A collected check number is not stop authority"); }
    return nativeKill(pid, signal);
  });
  try {
    const [run] = await owner.run();
    expect(owner.ready()).toBe(true);
    expect(run!.ok).toBe(false);
    expect(run!.execution).toMatchObject({ started: true, exit: { status: "reported", code: 0 }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "output" }, cleanup: "unconfirmed", outputCleanup: "confirmed" });
    expect(run!.cleanupIncomplete).toBe(true);
    expect(run!.output).toContain("Leader finished");
    expect(signals).toEqual([]);
    expect(owner.child()!.stdout.locked).toBe(false);
    expect(owner.child()!.stderr.locked).toBe(false);
  } finally { signalling.mockRestore(); await owner.close(); }
});
