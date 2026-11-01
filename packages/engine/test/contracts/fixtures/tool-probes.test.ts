import { expect, it } from "bun:test";
import { EXTRA_PROVIDER_IDS } from "@petrina/core";
import { rejectionOf } from "@petrina/test-support/rejections";
import { scriptedToolProbe, strictScriptedToolProbe } from "../../scripted-probes.js";

it("refuses missing baseline observations, defaults omitted optional providers, and clones mutable result records", async () => {
  const probe = scriptedToolProbe({ codex: { status: "ready" } });
  const strict = strictScriptedToolProbe({ codex: { status: "ready" } });
  const signal = new AbortController();
  const request = { signal: signal.signal, onGone: () => {} };

  expect(() => probe.absent("claude-code")).toThrow("No scripted tool probe for claude-code");
  expect(String(await rejectionOf(probe.run("claude-code", request)))).toContain("No scripted tool probe for claude-code");
  expect(() => probe.absent("git")).toThrow("No scripted tool probe for git");

  for (const extraId of EXTRA_PROVIDER_IDS) {
    expect(probe.absent(extraId)).toBe(true);
    expect(await probe.run(extraId, request)).toEqual({ status: "not-installed" });
    expect(() => strict.absent(extraId)).toThrow(`No scripted tool probe for ${extraId}`);
  }

  const first = await probe.run("codex", request);
  first.status = "logged-out";
  expect(await probe.run("codex", request)).toEqual({ status: "ready" });

  signal.abort();
  expect(String(await rejectionOf(probe.run("codex", request)))).toContain("was stopped");
});
