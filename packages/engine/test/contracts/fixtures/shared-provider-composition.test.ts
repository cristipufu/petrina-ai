import { expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { BUILT_IN_ROLES, DEFAULT_PROFILES } from "@petrina/core";
import type { AgentSessionOptions } from "@petrina/orchestrator";
import { tempDir, removeDir } from "../../fixtures.js";
import { sharedAgents } from "../../fixtures/shared-agents.js";

it("composes the same canonical shared replies without changing session recording or reopen behavior", async () => {
  const root = tempDir("petrina-shared-replies-"), f = sharedAgents(root);
  const role = BUILT_IN_ROLES.find(role => role.result === "build")!;
  const options: AgentSessionOptions = { profile: DEFAULT_PROFILES.find(profile => profile.id === "sol-high")!,
    cwd: root, signal: new AbortController().signal, browser: false,
    callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } };
  const session = await f.start(options, role);
  try {
    const original = await session.prompt("# The task: Add a greeting");
    const observed = f.agents.received()[0]!;
    expect(await f.respond(observed, options.signal, options.callbacks)).toBe(original.text);
    expect(readFileSync(join(root, "greeting.txt"), "utf8")).toBe("Hello\n");
    expect(f.agents.received()).toHaveLength(1);
    const resumed = await f.start({ ...options, reopen: session.sessionId }, role);
    try {
      expect(resumed.sessionId).toBe(session.sessionId);
      expect(resumed.reopened).toBe("resume");
    } finally { await resumed.stop(); }
  } finally { await session.stop(); removeDir(root); }
});
