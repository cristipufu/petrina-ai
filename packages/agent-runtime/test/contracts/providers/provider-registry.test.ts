import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHECK_IDS,
  CHECK_NAMES,
  DEFAULT_PROFILES,
  fixFor,
  isGuide,
  PROVIDER_DESCRIPTORS,
  PROVIDER_IDS,
  supportsLiveGuidance,
  TAKE_OVER_TOOLS,
  type CheckId,
  type Platform,
} from "@petrina/core";
import { ADAPTERS, EMBEDDED_ACP_TARGETS, PROVIDER_ADAPTERS } from "../../../src/providers/index.js";
import { terminalArgumentsFor } from "../../../src/terminal-arguments.js";
import { launchPlan, UnsafeValue } from "../../../src/terminal-plan.js";

const PLATFORMS: readonly Platform[] = ["darwin", "win32", "linux"];
const SAMPLE_UUID = "01234567-89ab-4def-8123-456789abcdef";
const FORBIDDEN_TAKEOVER_FLAGS = new Set([
  "--yolo",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--always-approve",
]);

describe("provider catalog and runtime plugin registry parity", () => {
  it("registers one runtime adapter per catalog provider with no missing or extra entries", () => {
    expect(PROVIDER_IDS.length).toBeGreaterThan(0);
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
    expect(Object.keys(PROVIDER_ADAPTERS).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(Object.keys(ADAPTERS).sort()).toEqual([...PROVIDER_IDS].sort());

    const profileIds = DEFAULT_PROFILES.map((profile) => profile.id);
    expect(new Set(profileIds).size).toBe(profileIds.length);
  });

  for (const provider of PROVIDER_DESCRIPTORS) {
    it(`enforces end-to-end descriptor, readiness, takeover, UI and runtime invariants for ${provider.id}`, () => {
      const adapter = ADAPTERS[provider.id];
      expect(adapter).toBeDefined();
      expect(adapter!.id).toBe(provider.id);
      expect(adapter!.name).toBe(provider.name);
      expect(adapter!.cli).toBe(provider.cli);
      expect(adapter!.models).toEqual(provider.models);
      expect(Boolean(adapter!.reportsSandbox)).toBe(Boolean(provider.capabilities.reportsSandbox));

      const checkId = provider.id as CheckId;
      expect(CHECK_IDS).toContain(checkId);
      expect(CHECK_NAMES[checkId]).toBe(provider.name);
      for (const platform of PLATFORMS) {
        for (const status of ["not-installed", "logged-out"] as const) {
          const fix = fixFor(checkId, status, platform);
          expect(fix).toBeDefined();
          expect(fix!.sentence.length).toBeGreaterThan(10);
          expect(fix!.command && fix!.command.length > 0).toBe(true);
          expect(fix!.guide.startsWith("https://")).toBe(true);
          expect(isGuide(fix!.guide)).toBe(true);
        }
      }

      const cssTokenOrHex = /^(#[0-9a-f]{6}|var\(--[a-z0-9-]+\))$/i;
      expect(provider.theme.light).toMatch(cssTokenOrHex);
      expect(provider.theme.dark).toMatch(cssTokenOrHex);
      expect(provider.icon.endsWith(".svg")).toBe(true);
      const iconPath = resolve(import.meta.dir, "../../../../../apps/desktop/public/tools", provider.icon);
      expect(existsSync(iconPath)).toBe(true);

      const providerProfiles = DEFAULT_PROFILES.filter((profile) => profile.toolId === provider.id);
      expect(providerProfiles.length).toBe(provider.profiles.length);
      for (const profile of providerProfiles) {
        const matchesCatalogModel = provider.models.includes(profile.model);
        const matchesDisplayName =
          profile.modelId !== undefined && provider.modelDisplayNames?.[profile.modelId] === profile.model;
        expect(matchesCatalogModel || matchesDisplayName).toBe(true);
      }

      expect(Boolean(TAKE_OVER_TOOLS[provider.id])).toBe(provider.capabilities.terminalTakeover);
      expect(Boolean(provider.terminal)).toBe(provider.capabilities.terminalTakeover);
      expect(Boolean(terminalArgumentsFor(provider.id))).toBe(provider.capabilities.terminalTakeover);
      if (provider.capabilities.terminalTakeover) {
        const plan = launchPlan(
          {
            platform: "darwin",
            dir: "/tmp/petrina-takeover",
            worktree: "/tmp/petrina-worktree",
            tool: {
              id: provider.id as Parameters<typeof launchPlan>[0]["tool"]["id"],
              name: provider.name,
              path: `/usr/local/bin/${provider.cli}`,
            },
            sessionId: SAMPLE_UUID,
            model: providerProfiles[0]?.modelId ?? "default",
            effort: providerProfiles[0]?.effort ?? "high",
          },
          terminalArgumentsFor(provider.id),
        );
        for (const arg of plan.args) {
          expect(FORBIDDEN_TAKEOVER_FLAGS.has(arg)).toBe(false);
        }
        expect(() =>
          launchPlan(
            {
              platform: "darwin",
              dir: "/tmp/petrina-takeover",
              worktree: "/tmp/petrina-worktree",
              tool: {
                id: provider.id as Parameters<typeof launchPlan>[0]["tool"]["id"],
                name: provider.name,
                path: `/usr/local/bin/${provider.cli}`,
              },
              sessionId: "not a valid session; rm -rf /",
              model: "default",
              effort: "high",
            },
            terminalArgumentsFor(provider.id),
          ),
        ).toThrow(UnsafeValue);
      }

      expect(supportsLiveGuidance(provider.id)).toBe(provider.capabilities.liveGuidance);
      expect(Boolean(adapter!.liveInput)).toBe(provider.capabilities.liveGuidance);

      if (adapter!.internalSubcommand) {
        expect(adapter!.internalSourceFile).toBeDefined();
        expect(typeof adapter!.internalRunner).toBe("function");
        const sourcePath = resolve(import.meta.dir, "../../../src", adapter!.internalSourceFile!);
        expect(existsSync(sourcePath)).toBe(true);
        expect(EMBEDDED_ACP_TARGETS).toContainEqual({
          id: provider.id as (typeof EMBEDDED_ACP_TARGETS)[number]["id"],
          name: provider.name,
          cli: provider.cli,
          subcommand: adapter!.internalSubcommand,
        });
      } else {
        expect(Boolean(adapter!.command || adapter!.entry)).toBe(true);
      }
    });
  }
});
