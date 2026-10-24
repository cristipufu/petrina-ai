import { expect, it } from "bun:test";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { rejectionOf } from "../../rejections.js";

it("refuses missing observations, aborted probes and shared mutable result records", async () => {
  const probe = scriptedToolProbe({ codex: { status: "ready" } });
  const signal = new AbortController(), request = { signal: signal.signal, onGone: () => {} };
  expect(() => probe.absent("grok")).toThrow("No scripted tool probe for grok");
  expect(String(await rejectionOf(probe.run("grok", request)))).toContain("No scripted tool probe for grok");
  const first = await probe.run("codex", request); first.status = "logged-out";
  expect(await probe.run("codex", request)).toEqual({ status: "ready" });
  signal.abort();
  expect(String(await rejectionOf(probe.run("codex", request)))).toContain("was stopped");
});
