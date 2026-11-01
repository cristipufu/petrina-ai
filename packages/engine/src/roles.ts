// Every role's contract with Petrina: derived strictly from `role.result` and declarative `Role` fields
// via `ENGINE_RESULT_STRATEGIES` and `ROLE_RESULT_CATALOG`, never from role IDs.

import type { z } from "zod";
import {
  BUILT_IN_ROLES,
  freshBuilderRethink,
  plannerRoles,
  reviewRound,
  ROLE_RESULT_CATALOG,
  stepBack,
  type Role,
} from "@petrina/core";
import type { PromptContext } from "./prompts.js";
import {
  CONTEXT_PARTS,
  ENGINE_RESULT_STRATEGIES,
  formatShapeJson,
  type ContextPart,
} from "./result-strategies.js";
import {
  BriefResult,
  BuildResult,
  CheckFinderResult,
  GuideResult,
  NotesResult,
  ObjectionsResult,
  PlanResult,
  ReleaseNotesResult,
  ReviewResult,
  TestResult,
  TEXT_LIMITS,
  VerifyResult,
} from "./role-schemas.js";

export {
  BriefResult,
  BuildResult,
  CheckFinderResult,
  CONTEXT_PARTS,
  freshBuilderRethink,
  GuideResult,
  NotesResult,
  ObjectionsResult,
  plannerRoles,
  PlanResult,
  ReleaseNotesResult,
  reviewRound,
  ReviewResult,
  stepBack,
  TestResult,
  TEXT_LIMITS,
  VerifyResult,
  type ContextPart,
};

export interface RoleContract {
  /** Review independence and baseline policies follow the contract, including added roles. */
  awayFromBuilder?: boolean;
  incrementalReview?: boolean;
  /** What it must hand back. */
  result: z.ZodType<unknown>;
  /** What it is shown besides its instructions. */
  reads: readonly ContextPart[];
  /** The JSON shape of its result, shown at the end of its instructions. */
  shape: string | ((ctx: PromptContext) => string);
  /** Its job on this task. */
  instructions: (ctx: PromptContext) => string;
  /** A saved job whose task-specific introduction sits outside the editable wording. */
  withInstructions?: (ctx: PromptContext, wording: string) => string;
}

const effectiveRole = (ctx: PromptContext, boundRole: Role): Role =>
  ctx.role.id === boundRole.id ? ctx.role : boundRole;

function resolveIncrementalReview(role: Role): boolean {
  const builtIn = BUILT_IN_ROLES.find((entry) => entry.id === role.id);
  const builtInContract =
    builtIn && role.fullReview === builtIn.fullReview ? ROLE_CONTRACTS[role.id] : undefined;
  if (builtInContract?.incrementalReview !== undefined) return builtInContract.incrementalReview;
  return ENGINE_RESULT_STRATEGIES[role.result].incrementalReview?.(role) === true;
}

function buildRoleContract(boundRole: Role): RoleContract {
  const strategy = ENGINE_RESULT_STRATEGIES[boundRole.result];
  const incremental = strategy.incrementalReview?.(boundRole);
  return {
    ...(boundRole.awayFromBuilder !== undefined ? { awayFromBuilder: boundRole.awayFromBuilder } : {}),
    ...(incremental !== undefined ? { incrementalReview: incremental } : {}),
    result: strategy.schema,
    reads: strategy.reads,
    shape: (ctx) => strategy.shape(ctx, effectiveRole(ctx, boundRole)),
    instructions: (ctx) =>
      strategy.instructions(ctx, effectiveRole(ctx, boundRole), resolveIncrementalReview),
    ...(strategy.withInstructions
      ? {
          withInstructions: (ctx: PromptContext, wording: string) =>
            strategy.withInstructions!(
              ctx,
              wording,
              effectiveRole(ctx, boundRole),
              resolveIncrementalReview,
            ),
        }
      : {}),
  };
}

export const ROLE_CONTRACTS: Readonly<Record<string, RoleContract>> = Object.fromEntries(
  BUILT_IN_ROLES.map((role) => [role.id, buildRoleContract(role)]),
);

const MAINTENANCE_COMPLETION_RULE =
  '\nSet "complete" to true only after completing the bounded investigation. Return false for an incomplete investigation and explain what prevented completion. Distinguish findings from missing evidence.\n';

/** The contract follows the result, so a coordinator's added or custom role works like any built-in role. */
export function contractFor(role: Role): RoleContract {
  const strategy = ENGINE_RESULT_STRATEGIES[role.result];
  const builtIn = BUILT_IN_ROLES.find((entry) => entry.id === role.id);
  const builtInContract =
    builtIn && role.fullReview === builtIn.fullReview ? ROLE_CONTRACTS[role.id] : undefined;
  const base = builtInContract ?? buildRoleContract(role);
  const contract =
    role.awayFromBuilder !== undefined ? { ...base, awayFromBuilder: role.awayFromBuilder } : base;
  if (strategy.bypassContractWrap) return contract;
  const instructions = (ctx: PromptContext): string => {
    const activeCtx = ctx.role.id === role.id ? ctx : { ...ctx, role };
    if (builtIn && role.instructions === builtIn.instructions) return contract.instructions(activeCtx);
    return contract.withInstructions
      ? contract.withInstructions(activeCtx, role.instructions)
      : role.instructions;
  };
  return {
    ...contract,
    instructions: (ctx) => {
      const text =
        instructions(ctx) + (role.category === "maintenance" ? MAINTENANCE_COMPLETION_RULE : "");
      const missing = strategy.requiredRules(ctx).filter((rule) => !text.includes(rule));
      return missing.length ? `${text}\n${missing.join("\n")}` : text;
    },
  };
}

export function shapeFor(contract: RoleContract, ctx: PromptContext): string {
  const baseShape = typeof contract.shape === "function" ? contract.shape(ctx) : contract.shape;
  const extra: Record<string, unknown> = {};
  if (
    ctx.role.result === "findings"
    && ctx.task.plan?.stages.some(
      (stage) => stage.kind === "do" && ctx.roles?.find((role) => role.id === stage.roleId)?.result === "checks",
    )
  ) {
    extra.proofRequests = [
      {
        text: "What must be proved on the final version",
        productIds: ["<affected product id>"],
        reason: "Why this proof is required",
        checklistText: "<optional exact saved checklist text>",
      },
    ];
  }
  if (ctx.role.result === "checks" && ctx.task.proofRequests?.length) {
    extra.proofAnswers = [
      {
        id: "<proof request id>",
        result: "pass",
        evidence: "The scenario and observed result",
        reason: "What prevented verification when blocked",
      },
    ];
  }
  if (ctx.role.category === "maintenance") {
    extra.complete = true;
  }
  if (ROLE_RESULT_CATALOG[ctx.role.result].allowsReportImages) {
    extra.images = [
      { path: "A chosen browser capture", caption: "What the picture demonstrates, in plain language" },
    ];
  }
  if (!Object.keys(extra).length) return baseShape;
  const parsed = JSON.parse(baseShape) as Record<string, unknown>;
  return formatShapeJson({ ...parsed, ...extra });
}
