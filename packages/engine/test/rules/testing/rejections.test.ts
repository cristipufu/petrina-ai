import { expect, it } from "bun:test";
import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";

it("yields before a pending rejection so other I/O cannot run inside the assertion's calling frame", async () => {
  const pending = Promise.withResolvers<never>();
  let returned = false;
  const assertion = expectRejection(pending.promise, "expected failure");
  returned = true;
  queueMicrotask(() => {
    expect(returned).toBe(true);
    pending.reject(new Error("expected failure"));
  });
  await assertion;
});

it("keeps the exact rejection and the throw matcher's message, pattern and type assertions", async () => {
  const error = new TypeError("expected failure");
  expect(await rejectionOf(Promise.reject(error))).toBe(error);
  await expectRejection(Promise.reject(error), "expected failure");
  await expectRejection(Promise.reject(error), /expected.*failure/);
  await expectRejection(Promise.reject(error), TypeError);
  await expectRejection(Promise.reject(error));
  const mismatch = await rejectionOf(expectRejection(Promise.reject(error), "another failure"));
  expect(mismatch).toBeInstanceOf(Error);
  const fulfilled = await rejectionOf(expectRejection(Promise.resolve("success")));
  expect(fulfilled).toBeInstanceOf(Error);
  expect((fulfilled as Error).message).toContain("completed successfully");
});
