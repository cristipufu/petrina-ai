import { expect, it } from "bun:test";
import { runCommand } from "@petrina/test-support/commands";
import { rejectionOf } from "@petrina/test-support/rejections";
import { timerObservation } from "../../fixtures/timer-observations.js";

it("rejects timer observations from a child that reports data but later fails", async () => {
  const result = await runCommand([process.execPath, "--no-env-file", "-e", `process.stdout.write('{"checkpointCalls":1}'); process.stderr.write('late timer failure'); process.exit(1);`]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ checkpointCalls: 1 });
  const error = await rejectionOf(timerObservation("unused-private-root", "registration", async () => result));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("exited 1: late timer failure");
});
