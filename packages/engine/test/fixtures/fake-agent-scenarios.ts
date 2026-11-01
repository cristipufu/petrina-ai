import type { RoleResult } from "@petrina/core";
import { findingIds } from "../scripted-findings.js";
import type { AgentScript, Scenario } from "../fake-agent.js";

export interface FakeConfigOption {
  id: string;
  name: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string }[];
}

export const SECURITY_FINDING = "Anyone can ask for the greeting as often as they like.";
export const DISPUTE_REASON = "The greeting's wording is the copywriter's call, not a review finding.";
export const SCREEN_REASON = "Check that the quick note window opens from the menu bar";
export const NOTES =
  "The coordinator's notes on this task (preserve product decisions; read each instruction in its original step)";

const DESIGN_CHECK = { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" };
const DESIGN_SCREENS = { kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };

export const block = (value: unknown, prose = "Done."): string =>
  `${prose}\n\n\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;

export const selectOption = (id: string, values: string[], names: string[] = values): FakeConfigOption => ({
  type: "select",
  id,
  name: id,
  currentValue: values[0]!,
  options: values.map((value, index) => ({ value, name: names[index]! })),
});

export const defaultConfigOptions = (plan: Scenario): FakeConfigOption[] => [
  selectOption("model", [
    "default",
    "opus",
    "sonnet",
    "gpt-6-astra",
    ...(plan.maintenance?.unsupported ? [] : ["gpt-6.1-sol"]),
    "grok-4.7",
    "gemini-4-argon",
    "gemini-3.8-flash",
  ]),
  selectOption("effort", ["high", "xhigh"]),
  selectOption("reasoning_effort", ["low", "medium", "high", "xhigh", "ultra"]),
  selectOption("thinking_level", ["low", "medium", "high"]),
  selectOption("mode", ["default", "auto", "agent", "auto_edit", "yolo"]),
];

export const roleOf = (text: string): string =>
  /You are the ([A-Za-z -]+) in Petrina/.exec(text)?.[1]?.trim().toLowerCase() ?? "";

const DIRECT_FAKE_ROLES = new Set([
  "planner",
  "architect",
  "design reviewer",
  "check finder",
  "builder",
  "code reviewer",
  "security reviewer",
  "verifier",
  "guide keeper",
  "tester",
  "release manager",
]);

const RESULT_FAKE_ROLE: Readonly<Partial<Record<RoleResult, string>>> = {
  plan: "planner",
  brief: "architect",
  objections: "design reviewer",
  "check-discovery": "check finder",
  build: "builder",
  votes: "verifier",
  guide: "guide keeper",
  checks: "tester",
  delivery: "release manager",
};

export function resultOf(text: string): RoleResult | undefined {
  const blockText = /```petrina\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (!blockText) return undefined;
  let shape: Record<string, unknown>;
  try {
    const parsed = JSON.parse(blockText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    shape = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if ("stages" in shape) return "plan";
  if ("forUsers" in shape) return "brief";
  if ("objections" in shape) return "objections";
  if ("changes" in shape) return "build";
  if ("verdicts" in shape) return "votes";
  if ("missed" in shape) return "guide";
  if ("verdict" in shape) return "findings";
  if ("checks" in shape) {
    const first = Array.isArray(shape.checks) ? shape.checks[0] : undefined;
    return first && typeof first === "object" && "argv" in first ? "check-discovery" : "checks";
  }
  if ("notes" in shape) return typeof shape.notes === "string" ? "delivery" : "notes";
  return undefined;
}

export function dispatchFakeRole(role: string, result: RoleResult | undefined): string {
  if (DIRECT_FAKE_ROLES.has(role)) return role;
  return (result ? RESULT_FAKE_ROLE[result] : undefined) ?? role;
}

export const slug = (role: string): string => role.replace(/[^a-z0-9]+/g, "-");

export const objectionIds = (text: string): string[] =>
  [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]!);

export function addedId(text: string, name: string): string {
  const id = new RegExp(`^- (added-[a-z0-9-]+) \\(${name}\\):`, "m").exec(text)?.[1];
  if (!id) throw new Error(`The planner's list has no ${name}`);
  return id;
}

export function riskOf(plan: Scenario): Record<string, unknown> {
  return {
    ...(plan.worksOn ? { worksOn: plan.worksOn } : {}),
    ...(plan.risk
      ? {
          risk: {
            level: plan.risk,
            why: plan.risk === "high" ? "It changes how people sign in." : "Only the greeting's words change.",
          },
        }
      : {}),
  };
}

export function plannerPayload(plan: Scenario, text: string): Record<string, unknown> {
  if (plan.planner === "research-first") {
    return {
      rationale: "Research it, build it, then review it.",
      stages: [
        { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      ],
    };
  }
  if (plan.planner === "tester-first") {
    return {
      rationale: "Build it, try it, then two reviewers.",
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
        { kind: "do", title: "Try it like a user", roleId: "tester", profileIds: ["opus-high"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-xhigh", "sol-xhigh"],
          maxRounds: 2,
        },
      ],
    };
  }
  if (plan.planner === "mixed-review") {
    return {
      rationale: "Build it, then a code reviewer and the added Security specialist review it together.",
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "sol-high"],
          roleIds: ["code-reviewer", addedId(text, "Security specialist")],
          maxRounds: 2,
        },
      ],
    };
  }
  if (plan.planner === "tester-after") {
    return {
      rationale: "Build it, one reviewer, then try it out.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
        { kind: "do", title: "Test", roleId: "tester", profileIds: ["opus-high"] },
      ],
    };
  }
  if (plan.planner === "claude-build") {
    return {
      rationale: "Build it on Claude Code, one reviewer on Codex.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["sol-high"],
          maxRounds: plan.reviewer === "confirm" ? 2 : 1,
        },
      ],
    };
  }
  if (plan.planner === "grok-build") {
    return {
      rationale: "Build it on Grok, one reviewer on Claude Code.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["grok-xhigh"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
      ],
    };
  }
  if (plan.planner === "two-opus") {
    return {
      rationale: "Build it, then two reviewers on Claude Code.",
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "opus-xhigh"],
          maxRounds: 1,
        },
      ],
    };
  }
  if (plan.planner === "pair" || plan.planner === "build-review") {
    return {
      rationale:
        plan.planner === "pair"
          ? "Build it, then two reviewers at once, one on each tool."
          : "Build it, then two reviewers.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "sol-high"],
          maxRounds: 1,
        },
      ],
    };
  }
  if (plan.planner === "limits") {
    return {
      rationale: "Exercise same-tool handoffs, design rounds and a mixed-tool review chain.",
      stages: [
        { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
        {
          kind: "converge",
          title: "Design",
          roleId: "architect",
          profileIds: ["opus-xhigh"],
          reviewerRoleId: "design-reviewer",
          reviewerProfileIds: ["sol-xhigh"],
          maxRounds: 2,
        },
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "opus-xhigh", "sol-high"],
          maxRounds: 2,
        },
      ],
    };
  }
  if (text.includes("[quick]")) {
    return {
      rationale: "A small change: build it, one reviewer.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
      ],
    };
  }
  if (plan.planner === "source-brief") {
    return {
      rationale: "Build it, then a review with the security reviewer.",
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "sol-high"],
          roleIds: ["code-reviewer", addedId(text, "Security specialist")],
          maxRounds: 1,
        },
      ],
    };
  }
  if (plan.planner === "source-roles") {
    return {
      rationale: "Build it, then the copywriter, a review with the security reviewer, and a fact check.",
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "sol-high"],
          roleIds: ["code-reviewer", addedId(text, "Security specialist")],
          maxRounds: 1,
        },
        { kind: "do", title: "Copy", roleId: addedId(text, "Copywriter"), profileIds: ["opus-high"] },
        { kind: "do", title: "Fact check", roleId: addedId(text, "Fact checker"), profileIds: ["opus-high"] },
      ],
    };
  }
  if (plan.planner === "roles") {
    return {
      rationale: "Research, a design, a build, then a review with the security reviewer you added.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Research", roleId: "researcher", profileIds: ["sol-high"] },
        {
          kind: "converge",
          title: "Design",
          roleId: "architect",
          profileIds: ["opus-xhigh"],
          reviewerRoleId: "design-reviewer",
          reviewerProfileIds: ["sol-xhigh"],
          maxRounds: 2,
        },
        DESIGN_CHECK,
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds: ["opus-high", "sol-high"],
          roleIds: ["code-reviewer", addedId(text, "Security specialist")],
          maxRounds: 2,
        },
        { kind: "do", title: "Copy", roleId: addedId(text, "Copywriter"), profileIds: ["opus-high"] },
        { kind: "do", title: "Fact check", roleId: addedId(text, "Fact checker"), profileIds: ["opus-high"] },
      ],
    };
  }
  if (plan.planner === "copy") {
    return {
      rationale: "Build it, then the copywriter you added, then one reviewer.",
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { kind: "do", title: "Copy", roleId: addedId(text, "Copywriter"), profileIds: ["opus-high"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
      ],
    };
  }
  if (
    plan.planner === "short"
    || plan.planner === "parallel"
    || plan.planner === "trio"
    || plan.planner === "two-codex"
  ) {
    return {
      rationale: "A small change: build it, one reviewer.",
      ...riskOf(plan),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        {
          kind: "review-chain",
          title: "Review",
          roleId: "code-reviewer",
          profileIds:
            plan.planner === "parallel"
              ? ["opus-high", "sol-high"]
              : plan.planner === "trio"
                ? ["opus-high", "sol-high", "grok-xhigh"]
                : plan.planner === "two-codex"
                  ? ["sol-high", "astra-xhigh"]
                  : ["opus-high"],
          maxRounds: plan.reviewRounds ?? 1,
        },
      ],
    };
  }
  return {
    rationale: "A small feature: agree on a design, build it, two reviewers.",
    ...riskOf(plan),
    stages: [
      {
        kind: "converge",
        title: "Design",
        roleId: "architect",
        profileIds: ["opus-xhigh"],
        reviewerRoleId: "design-reviewer",
        reviewerProfileIds: ["sol-xhigh"],
        maxRounds: 2,
      },
      ...(text.includes("[no-check]")
        ? []
        : text.includes("[screens]")
          ? [DESIGN_SCREENS, DESIGN_CHECK]
          : text.includes("[two-checks]")
            ? [DESIGN_CHECK, DESIGN_SCREENS, DESIGN_CHECK]
            : [DESIGN_CHECK]),
      { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ...(plan.planner === "tester-with-design"
        ? [{ kind: "do", title: "Try acceptance", roleId: "tester", profileIds: ["opus-high"] }]
        : []),
      {
        kind: "review-chain",
        title: "Review",
        roleId: "code-reviewer",
        profileIds: ["opus-high", "sol-high"],
        maxRounds: plan.reviewRounds ?? 2,
      },
    ],
  };
}

export function checkFinderPayload(
  plan: Scenario,
  scriptChecks: AgentScript["checks"],
  execPath: string,
): { broken: true; text: string } | { broken: false; payload: Record<string, unknown> } {
  if (plan.checks === "broken") {
    return { broken: true, text: "I could not work out how this product is checked." };
  }
  if (scriptChecks) {
    return { broken: false, payload: { summary: "Checked the way this test asks.", checks: scriptChecks } };
  }
  return {
    broken: false,
    payload: {
      summary: "Checked with git, which every test machine has.",
      checks:
        plan.checks === "fail"
          ? [{ name: "Tests", argv: ["git", "no-such-subcommand-petrina"], why: "A check that fails, for tests" }]
          : plan.checks === "writes"
            ? [{ name: "Format", argv: ["git", "mv", "README.md", "README.txt"], why: "A check that changes a tracked file, for tests" }]
            : plan.checks === "slow"
              ? [{ name: "Slow", argv: [execPath, "-e", "await Bun.sleep(1500)"], why: "A check that takes a moment, for tests" }]
              : plan.checks === "commits"
                ? [{ name: "Sneaky", argv: ["git", "commit", "-q", "--allow-empty", "-m", "Not reviewed"], why: "A check that commits, for tests" }]
                : [{ name: "Version", argv: ["git", "--version"], why: "A check that passes, for tests" }],
    },
  };
}

export function designReviewerPayload(
  plan: Scenario,
  text: string,
): { payload: Record<string, unknown>; silent?: true } {
  if (plan.planner === "limits" && !text.includes("Objections so far")) {
    return { payload: { objections: [{ text: "Explain who sees the greeting.", blocking: true }] } };
  }
  if (text.includes("[follow-up]")) {
    return { payload: { objections: [{ text: "Follow-up: name the greeting's colour later.", blocking: false }] } };
  }
  if (text.includes("[disagree]")) {
    return {
      payload: {
        objections: [
          { text: "The brief does not say who sees the greeting.", blocking: true },
          { text: "Consider a greeting per language.", blocking: false },
        ],
      },
    };
  }
  return { payload: { objections: [] }, silent: true };
}

export function guideKeeperPayload(
  plan: Scenario,
): { broken: true; text: string } | { broken: false; payload: Record<string, unknown> } {
  if (plan.guide === "broken") {
    return { broken: true, text: "I could not tell what the reviewers missed." };
  }
  return {
    broken: false,
    payload:
      plan.guide === "change of mind"
        ? { missed: false, line: "", why: "The note asks for a new colour: a change of mind, not a miss." }
        : {
            missed: true,
            line: "Every greeting also shows on the welcome page.",
            why: "The reviewers checked the greeting only where it was added.",
          },
  };
}

export function verifierVerdictsPayload(
  plan: Scenario,
  text: string,
  model: string | undefined,
  notABug: boolean,
): Record<string, unknown> {
  const ids = findingIds(text, "Important findings to check (a verdict on every one, by id)");
  const verdict =
    plan.verifierByModel?.[model ?? ""]
    ?? (plan.verifier === "after-fix-not-a-bug"
      ? text.includes("  The builder: fixed.")
        ? "not-a-bug"
        : "real"
      : plan.verifier === "split"
        ? notABug
          ? "not-a-bug"
          : "real"
        : plan.verifier === "hold"
          ? "real"
          : plan.verifier)
    ?? "real";
  return {
    verdicts: (plan.partialVerification ? ids.slice(0, 1) : ids).map((id) => {
      const given = plan.verifierByFinding?.[id]?.[model ?? ""] ?? verdict;
      return {
        id,
        verdict: given,
        reason:
          given === "not-a-bug"
            ? "The welcome page shows the greeting already."
            : given === "real"
              ? "The welcome page has no greeting: confirmed by opening it."
              : `It is ${given === "nit" ? "only a nit" : "older than this change"}: checked on ${model}.`,
      };
    }),
  };
}
