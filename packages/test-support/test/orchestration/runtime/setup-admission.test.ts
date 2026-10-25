import { expect, it } from "bun:test";
import { rejectionOf } from "../../../src/rejections.js";
import { setupAdmission } from "../../fixtures/setup-admission.js";

it("releases the next setup step after a failure without giving it the failed step's error", async () => {
  const { setup, drain } = setupAdmission(), failed = new Error("this setup failed");
  const first = rejectionOf(setup.run(() => { throw failed; }));
  const second = setup.run(() => "independent setup");
  await drain();
  expect(await first).toBe(failed);
  expect(await second).toBe("independent setup");
});

it("gives up a cancelled place without starting it or blocking later setup", async () => {
  const { setup, drain } = setupAdmission(), lifetime = new AbortController(), ended = new Error("the owner ended");
  let started = false;
  const first = setup.run(() => { lifetime.abort(ended); return "first"; });
  const cancelled = rejectionOf(setup.run(() => { started = true; }, lifetime.signal));
  const last = setup.run(() => "last");
  await drain();
  expect(await first).toBe("first");
  expect(await cancelled).toBe(ended);
  expect(started).toBe(false);
  expect(await last).toBe("last");
  expect(await rejectionOf(setup.run(() => { started = true; }, lifetime.signal))).toBe(ended);
  expect(started).toBe(false);
});

it("only schedules synchronous setup rather than waiting for a whole asynchronous test", async () => {
  const { setup, drain } = setupAdmission(), held = Promise.withResolvers<void>();
  const first = setup.run(() => held.promise);
  const second = setup.run(() => "another test can start");
  await drain();
  try { expect(await second).toBe("another test can start"); }
  finally { held.resolve(); await first; }
});
