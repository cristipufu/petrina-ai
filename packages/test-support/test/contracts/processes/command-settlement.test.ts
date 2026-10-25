import { expect, it } from "bun:test";
import { CommandFailure, type CommandResult } from "../../../src/commands.js";
import { settleCommandAfterStop } from "../../../src/command-settlement.js";
import { rejectionOf } from "../../../src/rejections.js";
import { settlementPeer } from "../../fixtures/settlement-peer.js";

it("accepts actual exit and both drained streams after the independent stop request", async () => {
  const peer = await settlementPeer(true);
  try {
    expect(peer.ready()).toBe(true);
    peer.requestStop();
    const settled = await settleCommandAfterStop(peer);
    expect(settled).toEqual({ kind: "completed", result: { code: 0, stdout: "drained-out\n", stderr: "drained-err\n" } });
  } finally { await peer.close(); }
});

it("forces only after its allowance when a prepared real actor ignores the stop request", async () => {
  const peer = await settlementPeer(false);
  try {
    expect(peer.ready()).toBe(true);
    peer.requestStop();
    let forced = false;
    const pending = settleCommandAfterStop({ result: peer.result, abort() { forced = true; peer.abort(); } }, 25);
    expect(forced).toBe(false);
    const settled = await pending;
    expect(forced).toBe(true);
    expect(settled.kind).toBe("stopped");
    if (settled.kind !== "stopped") throw new Error("The indefinitely live actor should need bounded cleanup");
    expect(settled.failure).toBeInstanceOf(CommandFailure);
    expect(settled.failure.cleanup).toBe("confirmed");
    expect(settled.failure.reason).toBe("cancelled");
  } finally { await peer.close(); }
});

it("retains the original confirmed canonical cleanup failure instead of inventing an exit result", async () => {
  const failure = new CommandFailure("Already stopped", "cancelled", "partial", "", "confirmed");
  const settled = await settleCommandAfterStop({ result: Promise.reject(failure), abort() { throw new Error("Must not force an already settled owner"); } });
  expect(settled.kind).toBe("stopped");
  expect(settled.kind === "stopped" && settled.failure).toBe(failure);
});

for (const failure of [new CommandFailure("Unknown", "timeout", "", "", "unconfirmed"), new Error("unavailable"), { cleanup: "confirmed" }, undefined])
  it(`rejects ${failure instanceof CommandFailure ? "unconfirmed canonical cleanup" : failure instanceof Error ? "ordinary errors" : failure ? "non-canonical cleanup claims" : "undefined rejection"}`, async () => {
    expect(await rejectionOf(settleCommandAfterStop({ result: Promise.reject(failure), abort() {} }))).toBe(failure);
  });

for (const code of [undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) it(`rejects an invalid completed exit code ${String(code)}`, async () => {
  const result = { code, stdout: "", stderr: "" } as CommandResult;
  expect(await rejectionOf(settleCommandAfterStop({ result: Promise.resolve(result), abort() {} }))).toBeInstanceOf(TypeError);
});

for (const allowance of [-1, NaN, Infinity, 2_147_483_648]) it(`rejects an unbounded allowance ${String(allowance)} and observes a later producer rejection`, async () => {
  const result = Promise.withResolvers<CommandResult>();
  expect(await rejectionOf(settleCommandAfterStop({ result: result.promise, abort() {} }, allowance))).toBeInstanceOf(RangeError);
  result.reject(new Error("Late producer failure"));
  await Promise.resolve();
});

it("rejects an abort failure while continuing to observe the producer's later rejection", async () => {
  const result = Promise.withResolvers<CommandResult>(), failure = new Error("The abort callback failed");
  expect(await rejectionOf(settleCommandAfterStop({ result: result.promise, abort() { throw failure; } }, 0))).toBe(failure);
  result.reject(new CommandFailure("Still unknown", "unreadable", "", "", "unconfirmed"));
  await Promise.resolve();
});

it("retains a valid nonzero completed result without calling the force operation", async () => {
  const result: CommandResult = { code: 3, stdout: "partial\n", stderr: "explanation\n" };
  expect(await settleCommandAfterStop({ result: Promise.resolve(result), abort() { throw new Error("A completed result needs no force"); } })).toEqual({ kind: "completed", result });
});

it("invokes a method-backed stop owner with its actual receiver", async () => {
  const result = Promise.withResolvers<CommandResult>(), seen: string[] = [];
  const failure = new CommandFailure("Stopped", "cancelled", "", "", "confirmed");
  class Owner {
    readonly marker = "owned";
    readonly result = result.promise;
    abort() { seen.push(this.marker); result.reject(failure); }
  }
  const settled = await settleCommandAfterStop(new Owner(), 0);
  expect(seen).toEqual(["owned"]);
  expect(settled.kind).toBe("stopped");
  expect(settled.kind === "stopped" && settled.failure).toBe(failure);
});
