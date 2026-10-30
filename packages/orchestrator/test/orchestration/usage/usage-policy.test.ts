import { DEFAULT_PROFILES, KNOWN_TOOLS, type DeepMutable, type Pool, type State } from "@petrina/core";
import { describe, expect, it } from "vitest";
import { UsagePolicy, recordModelCapacity } from "../../../src/index.js";
import { repositoryTask } from "../../fixtures/tasks.js";

type SetupCheck = NonNullable<State["setup"]>["checks"][number];

describe("portable usage policy", () => {
  it("resolves usable tools, matches effort on fallback profiles, and expires pool and task limits", () => {
    const pool: DeepMutable<Pool> = { limit: 2, paused: false, toolCaps: {} };
    const task = repositoryTask(false);
    let checks: SetupCheck[] | undefined = [
      { id: "claude-code", status: "not-installed", detail: "Not installed" },
      { id: "codex", status: "ready", detail: "Ready" },
    ];
    const policy = new UsagePolicy({
      pool: () => pool,
      tasks: () => [task],
      profiles: () => DEFAULT_PROFILES,
      tools: () => KNOWN_TOOLS.map((tool) => ({ ...tool, status: "ready" as const })),
      setupChecks: () => checks,
      hasToolAdapter: (id) => KNOWN_TOOLS.some((tool) => tool.id === id),
    });

    expect(policy.usableTools()).toEqual(["codex"]);
    const fallback = policy.onUsable("opus-xhigh");
    const chosen = DEFAULT_PROFILES.find((profile) => profile.id === fallback);
    expect(chosen?.toolId).toBe("codex");
    expect(chosen?.effort).toBe("xhigh");

    const message = policy.recordLimitHit(
      { toolId: "codex", source: "refusal", until: 2_000, reason: "quota reached" },
      "Builder",
      "Sol",
      1_000,
    );
    expect(message).toContain("Builder on Sol ran out of usage (quota reached)");
    recordModelCapacity(task, "sol-high", { toolId: "codex", modelId: "gpt-5.4" }, 500, 1_000);
    expect(policy.nextLimitWakeAt(1_000)).toBe(1_500);

    expect(policy.expireLimits(1_600)).toBe(true);
    expect(task.modelCapacity).toBeUndefined();
    expect(policy.nextLimitWakeAt(1_600)).toBe(2_000);

    expect(policy.expireLimits(2_500)).toBe(true);
    expect(pool.limited).toBeUndefined();
    expect(policy.nextLimitWakeAt(2_500)).toBeUndefined();

    checks = undefined;
    expect(policy.usableTools().length).toBeGreaterThan(0);
  });
});
