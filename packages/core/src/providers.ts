// Single pure-data catalog of coding-agent providers. Every package derives tool identity,
// setup guides, capabilities, theme accents and default profiles from this module so adding
// a provider never requires parallel tables across core, runtime, engine, UI or test fixtures.

import type { AgentProfile, Effort, Tone, Tool } from "./model.js";

export type Platform = "darwin" | "win32" | "linux";
export type PerPlatform = string | Readonly<Record<Platform, string>>;

export interface ProviderVendor {
  readonly id: string;
  readonly label: string;
}

export interface VendorDescriptor extends ProviderVendor {
  readonly theme: { readonly light: string; readonly dark: string };
}

export const VENDOR_CATALOG = [
  { id: "anthropic", label: "Anthropic", theme: { light: "#d97757", dark: "#d4704f" } },
  { id: "openai", label: "OpenAI", theme: { light: "#10a37f", dark: "#10a37f" } },
  { id: "xai", label: "xAI", theme: { light: "#3f434b", dark: "#c9ccd2" } },
  { id: "google", label: "Google", theme: { light: "#4285f4", dark: "#6ea1ff" } },
  { id: "other", label: "Other", theme: { light: "#7a766e", dark: "#9a9ea6" } },
] as const satisfies readonly VendorDescriptor[];

export interface ModelFamilyDescriptor {
  readonly id: string;
  readonly pattern: RegExp;
  readonly tone: Tone;
}

export const MODEL_FAMILY_CATALOG: readonly ModelFamilyDescriptor[] = [
  { id: "opus", pattern: /opus/i, tone: "indigo" },
  { id: "sonnet", pattern: /sonnet/i, tone: "orange" },
  { id: "haiku", pattern: /haiku/i, tone: "green" },
  { id: "fable", pattern: /fable/i, tone: "pink" },
  { id: "gemini", pattern: /gemini/i, tone: "blue" },
  { id: "grok", pattern: /grok/i, tone: "teal" },
];

export interface ProviderIconStyle {
  readonly darkInvert?: boolean;
  readonly large?: boolean;
}

export interface ProviderTokenAccounting {
  /** Reasoning tokens are billed inside output and omitted as a separate count. */
  readonly foldsReasoningIntoOutput?: boolean;
  /** Per-model breakdown already includes subagents; without it, main counts only the main agent. */
  readonly breakdownIncludesHelpers?: boolean;
  /** Helper agents spawned during a turn are omitted from reported token totals. */
  readonly omitsSpawnedHelpers?: boolean;
  /** Model reroutes during a turn mark the single token line as changed. */
  readonly marksReroutedLine?: boolean;
  /** Normalize `modelRan` via `modelLabel` when formatting confirmed session model names. */
  readonly normalizeRanModelName?: boolean;
  /** Verified model alias sets that resolve to the same canonical model. */
  readonly modelAliasGroups?: readonly (readonly string[])[];
}

export interface ProviderUsageReporting {
  /** Supports overlapping plan and paid-overage windows requiring allowance reconciliation. */
  readonly supportsOverageAllowances?: boolean;
  /** Maps native per-model weekly window kinds (e.g. `seven_day_opus`) to canonical model family ids. */
  readonly modelWindowKinds?: Readonly<Record<string, string>>;
  /** Status-only reports without a measured percentage mean usage was not reported rather than "fine". */
  readonly requiresMeasuredPercentage?: boolean;
}

export interface TerminalArgumentInput {
  readonly session: string;
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
}

export type TerminalArgumentFormatter = (input: TerminalArgumentInput) => string[];

export interface ProviderTerminalSpec {
  readonly sessionPattern?: RegExp;
  readonly formatArgs: TerminalArgumentFormatter;
}

export interface ProviderProfileSeed extends Omit<AgentProfile, "toolId"> {
  /** Stand-in preference tier (0 = primary, 1 = secondary, 2 = standby / demo-retained / optional). */
  readonly rank?: 0 | 1 | 2;
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly cli: string;
  /** Starter tools always appear on First Run; optional tools join once detected on the machine. */
  readonly starter: boolean;
  /** Bundled brand SVG under `apps/desktop/public/tools/`, when available. */
  readonly icon?: string;
  readonly iconStyle?: ProviderIconStyle;
  /** Primary model vendor for Analytics provider charts, when one vendor backs the tool. */
  readonly vendor?: ProviderVendor;
  readonly setup: {
    readonly guides: { readonly install: string; readonly login?: string };
    readonly install: PerPlatform;
    readonly loginCommand?: string;
  };
  readonly capabilities: {
    readonly terminalTakeover: boolean;
    readonly liveGuidance: boolean;
    readonly reportsSandbox?: boolean;
    readonly sandboxTip?: string;
  };
  readonly tokenAccounting?: ProviderTokenAccounting;
  readonly usageReporting?: ProviderUsageReporting;
  readonly simTokenProfile?: "reasoning-single" | "cached-breakdown";
  readonly terminal?: ProviderTerminalSpec;
  readonly theme: { readonly light: string; readonly dark: string };
  readonly models: readonly string[];
  readonly catalogCommand?: readonly string[];
  readonly modelDisplayNames?: Readonly<Record<string, string>>;
  readonly extraDemoEfforts?: readonly Effort[];
  readonly profiles: readonly ProviderProfileSeed[];
}

const CLAUDE_SANDBOX_TIP = [
  "Claude Code's own sandbox: its commands can change only the working copy, temporary folders,",
  "package download caches and sign-in caches. Also the product's shared git history, and whatever",
  "your or the product's Claude Code settings allow. Reading, websites and your logins stay open,",
  "and Auto mode can let a command run outside it (on a Mac, SSH and headless browsers). On a Mac,",
  "process-list checks can fail; Petrina's own checks run the full test suite.",
].join(" ");

export const PROVIDER_CATALOG = [
  {
    id: "claude-code",
    name: "Claude Code",
    cli: "claude",
    starter: true,
    icon: "claude-code.svg",
    vendor: { id: "anthropic", label: "Anthropic" },
    setup: {
      guides: {
        install: "https://code.claude.com/docs/en/setup",
        login: "https://code.claude.com/docs/en/setup#authentication",
      },
      install: "npm install -g @anthropic-ai/claude-code",
      loginCommand: "claude auth login",
    },
    capabilities: {
      terminalTakeover: true,
      liveGuidance: true,
      reportsSandbox: true,
      sandboxTip: CLAUDE_SANDBOX_TIP,
    },
    tokenAccounting: {
      foldsReasoningIntoOutput: true,
      breakdownIncludesHelpers: true,
      marksReroutedLine: false,
    },
    usageReporting: {
      supportsOverageAllowances: true,
      modelWindowKinds: {
        seven_day_opus: "opus",
        seven_day_sonnet: "sonnet",
        seven_day_overage_included: "fable",
      },
    },
    terminal: {
      formatArgs: ({ session, model, effort, mode }) => [
        "--resume",
        session,
        "--model",
        model,
        "--effort",
        effort,
        "--permission-mode",
        mode,
      ],
    },
    theme: { light: "#d97757", dark: "#d4704f" },
    models: ["Opus 5.5", "Fable 5.1", "Sonnet 5.5"],
    catalogCommand: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
    extraDemoEfforts: ["medium"],
    profiles: [
      { id: "opus-xhigh", model: "Opus 5.5", modelId: "opus", effort: "xhigh", rank: 0 },
      { id: "opus-high", model: "Opus 5.5", modelId: "opus", effort: "high", rank: 0 },
      { id: "fable-xhigh", model: "Fable 5.1", modelId: "fable", effort: "xhigh", rank: 1 },
      { id: "sonnet-high", model: "Sonnet 5.5", modelId: "sonnet", effort: "high", standby: true, rank: 2 },
      { id: "sonnet-medium", model: "Sonnet 5.5", modelId: "sonnet", effort: "medium", rank: 2 },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    cli: "codex",
    starter: true,
    icon: "codex.svg",
    iconStyle: { darkInvert: true },
    vendor: { id: "openai", label: "OpenAI" },
    setup: {
      guides: {
        install: "https://developers.openai.com/codex/cli",
        login: "https://developers.openai.com/codex/auth",
      },
      install: "npm install -g @openai/codex",
      loginCommand: "codex login",
    },
    capabilities: {
      terminalTakeover: true,
      liveGuidance: true,
      reportsSandbox: true,
      sandboxTip: "Sandboxed by Codex's own workspace sandbox, as Codex sets it.",
    },
    tokenAccounting: {
      omitsSpawnedHelpers: true,
      marksReroutedLine: true,
    },
    usageReporting: {
      requiresMeasuredPercentage: true,
    },
    simTokenProfile: "reasoning-single",
    terminal: {
      formatArgs: ({ session, model, effort }) => [
        "resume",
        session,
        "--model",
        model,
        "-c",
        `model_reasoning_effort=${effort}`,
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "-c",
        "approvals_reviewer=user",
        "--no-daemon",
      ],
    },
    theme: { light: "#10a37f", dark: "#10a37f" },
    models: ["sol", "astra"],
    catalogCommand: ["npx", "-y", "@agentclientprotocol/codex-acp"],
    modelDisplayNames: {
      "gpt-6.1-sol": "GPT-6.1 Sol",
      "gpt-6-astra": "GPT-6 Astra",
    },
    profiles: [
      { id: "sol-xhigh", model: "sol", modelId: "gpt-6.1-sol", effort: "xhigh", rank: 0 },
      { id: "sol-high", model: "sol", modelId: "gpt-6.1-sol", effort: "high", rank: 0 },
      { id: "astra-xhigh", model: "astra", modelId: "gpt-6-astra", effort: "xhigh", rank: 1 },
      { id: "astra-ultra", model: "GPT-6 Astra", modelId: "gpt-6-astra", effort: "ultra", rank: 2 },
      { id: "sol-ultra", model: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", effort: "ultra", rank: 2 },
      { id: "sol-medium", model: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", effort: "medium", rank: 2 },
    ],
  },
  {
    id: "grok",
    name: "Grok",
    cli: "grok",
    starter: false,
    icon: "grok.svg",
    iconStyle: { darkInvert: true },
    vendor: { id: "xai", label: "xAI" },
    setup: {
      guides: {
        install: "https://docs.x.ai/build/overview",
        login: "https://docs.x.ai/build/cli/reference",
      },
      install: "npm install -g @xai-official/grok",
      loginCommand: "grok login",
    },
    capabilities: {
      terminalTakeover: true,
      liveGuidance: true,
    },
    tokenAccounting: {
      normalizeRanModelName: true,
      modelAliasGroups: [["grok-4.7", "grok-4.7-build"]],
    },
    terminal: {
      formatArgs: ({ session, model, effort }) => ["--resume", session, "--model", model, "--effort", effort],
    },
    theme: { light: "#5b6cff", dark: "#5b6cff" },
    models: ["Grok 4.7"],
    profiles: [
      { id: "grok-xhigh", model: "Grok 4.7", modelId: "grok-4.7", effort: "xhigh", rank: 0 },
      { id: "grok-high", model: "Grok 4.7", modelId: "grok-4.7", effort: "high", rank: 0 },
    ],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    cli: "agy",
    starter: false,
    icon: "antigravity.svg",
    iconStyle: { large: true },
    vendor: { id: "google", label: "Google" },
    setup: {
      guides: {
        install: "https://antigravity.google/docs/cli/install/",
        login: "https://antigravity.google/docs/cli/reference",
      },
      install: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
      loginCommand: "agy",
    },
    capabilities: {
      terminalTakeover: true,
      liveGuidance: false,
    },
    terminal: {
      formatArgs: ({ session, model, effort }) => ["--conversation", session, "--model", model, "--effort", effort],
    },
    theme: { light: "var(--t-teal)", dark: "var(--t-teal)" },
    models: ["Gemini 4 Argon", "Gemini 3.8 Flash"],
    profiles: [
      { id: "argon-high", model: "Gemini 4 Argon", modelId: "gemini-4-argon", effort: "high", rank: 0 },
      { id: "argon-medium", model: "Gemini 4 Argon", modelId: "gemini-4-argon", effort: "medium", rank: 0 },
      { id: "flash-high", model: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash", effort: "high", rank: 0 },
      { id: "flash-medium", model: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash", effort: "medium", rank: 0 },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    cli: "opencode",
    starter: false,
    setup: {
      guides: {
        install: "https://opencode.ai/docs",
        login: "https://opencode.ai/docs/providers",
      },
      install: {
        darwin: "curl -fsSL https://opencode.ai/install | bash",
        linux: "curl -fsSL https://opencode.ai/install | bash",
        win32: "npm install -g opencode-ai",
      },
      loginCommand: "opencode auth login",
    },
    capabilities: {
      terminalTakeover: true,
      liveGuidance: false,
    },
    terminal: {
      sessionPattern: /^ses_[A-Za-z0-9_-]{4,96}$/i,
      formatArgs: ({ session, model }) => ["-s", session, "--model", model],
    },
    theme: { light: "#6b7079", dark: "#9a9ea6" },
    models: ["Claude Sonnet 4.5", "GPT-5"],
    profiles: [
      {
        id: "opencode-sonnet-high",
        model: "Claude Sonnet 4.5",
        modelId: "anthropic/claude-sonnet-4-5",
        effort: "high",
        rank: 2,
      },
      { id: "opencode-gpt5-high", model: "GPT-5", modelId: "openai/gpt-5", effort: "high", rank: 2 },
    ],
  },
  {
    id: "pi",
    name: "Pi",
    cli: "pi",
    starter: false,
    setup: {
      guides: {
        install: "https://pi.dev",
        login: "https://pi.dev",
      },
      install: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
      loginCommand: "pi",
    },
    capabilities: {
      terminalTakeover: true,
      liveGuidance: true,
    },
    terminal: {
      sessionPattern: /^pi_[A-Za-z0-9_-]{4,96}$/i,
      formatArgs: ({ session, model, effort }) => ["--session", session, "--model", model, "--thinking", effort],
    },
    theme: { light: "#7c5ce6", dark: "#a78bfa" },
    models: ["Claude Sonnet 4.5", "GPT-5"],
    profiles: [
      {
        id: "pi-sonnet-high",
        model: "Claude Sonnet 4.5",
        modelId: "anthropic/claude-sonnet-4-5",
        effort: "high",
        rank: 2,
      },
      { id: "pi-gpt5-high", model: "GPT-5", modelId: "openai/gpt-5", effort: "high", rank: 2 },
    ],
  },
] as const satisfies readonly ProviderDescriptor[];

export type ProviderId = (typeof PROVIDER_CATALOG)[number]["id"];
export type StarterProviderId = Extract<(typeof PROVIDER_CATALOG)[number], { readonly starter: true }>["id"];
export type ExtraProviderId = Exclude<ProviderId, StarterProviderId>;

export const PROVIDER_IDS: readonly ProviderId[] = PROVIDER_CATALOG.map((provider) => provider.id);

export const STARTER_PROVIDER_IDS: readonly StarterProviderId[] = PROVIDER_CATALOG.filter(
  (provider): provider is Extract<(typeof PROVIDER_CATALOG)[number], { readonly starter: true }> => provider.starter,
).map((provider) => provider.id);

export const EXTRA_PROVIDER_IDS: readonly ExtraProviderId[] = PROVIDER_CATALOG.filter(
  (provider): provider is Extract<(typeof PROVIDER_CATALOG)[number], { readonly starter: false }> => !provider.starter,
).map((provider) => provider.id);

export const PROVIDER_BY_ID: Readonly<Record<ProviderId, ProviderDescriptor>> = Object.fromEntries(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider]),
) as unknown as Readonly<Record<ProviderId, ProviderDescriptor>>;

export function isProviderId(id: string): id is ProviderId {
  return Object.hasOwn(PROVIDER_BY_ID, id);
}

export function getProviderDescriptor(id: string | undefined): ProviderDescriptor | undefined {
  return id !== undefined && isProviderId(id) ? PROVIDER_BY_ID[id] : undefined;
}

export function supportsLiveGuidance(toolId: string | undefined): boolean {
  const provider = getProviderDescriptor(toolId);
  return provider ? provider.capabilities.liveGuidance : true;
}

export function providerSandboxTip(toolId: string | undefined): string | undefined {
  return getProviderDescriptor(toolId)?.capabilities.sandboxTip;
}

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = PROVIDER_CATALOG;

export const CATALOG_TOOLS: readonly Tool[] = PROVIDER_DESCRIPTORS.map((provider) => ({
  id: provider.id,
  name: provider.name,
  command: provider.catalogCommand ? [...provider.catalogCommand] : [provider.cli],
  status: provider.starter ? "ready" : "not-installed",
  models: [...provider.models],
}));
