import { PROVIDER_IDS, type ProviderId } from "@petrina/core";
import type { ToolAdapter } from "../tool-adapter.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { grokAdapter } from "./grok.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";

export const PROVIDER_ADAPTERS = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  antigravity: antigravityAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
} as const satisfies Readonly<Record<ProviderId, ToolAdapter>>;

export const ADAPTERS: Record<string, ToolAdapter> = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, PROVIDER_ADAPTERS[id]]),
);

export interface EmbeddedAcpTarget {
  readonly id: ProviderId;
  readonly name: string;
  readonly cli: string;
  readonly subcommand: NonNullable<ToolAdapter["internalSubcommand"]>;
}

export const EMBEDDED_ACP_TARGETS: readonly EmbeddedAcpTarget[] = PROVIDER_IDS.flatMap((id) => {
  const adapter = PROVIDER_ADAPTERS[id];
  return adapter.internalSubcommand
    ? [{ id, name: adapter.name, cli: adapter.cli, subcommand: adapter.internalSubcommand }]
    : [];
});

export async function runEmbeddedAcpSubcommand(
  command: string | undefined,
  args: readonly string[],
): Promise<boolean> {
  if (!command) return false;
  for (const id of PROVIDER_IDS) {
    const adapter = PROVIDER_ADAPTERS[id];
    if (adapter.internalSubcommand === command && adapter.internalRunner) {
      await adapter.internalRunner(args);
      return true;
    }
  }
  return false;
}
