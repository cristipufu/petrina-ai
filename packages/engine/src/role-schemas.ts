import { STAGE_KINDS } from "@petrina/core";
import { z } from "zod";
import { WorkChoiceSchema } from "./source-schema.js";

/** Optional navigation: the engine keeps each valid entry, so malformed hints never cost an otherwise usable result. */
const SourcePointers = z.unknown().optional();

export const PlanResult = z.object({
  sourcePointers: SourcePointers,
  worksOn: z.array(WorkChoiceSchema).max(20).optional(),
  leadProductId: z.string().optional(),
  rationale: z.string().min(3),
  stages: z
    .array(
      z.object({
        kind: z.enum(STAGE_KINDS),
        title: z.string().min(1).max(60),
        roleId: z.string(),
        profileIds: z.array(z.string()).default([]),
        profileReasons: z.array(z.string().trim().min(3).max(300)).max(12).optional(),
        roleIds: z.array(z.string()).max(12).optional(),
        reviewerRoleId: z.string().optional(),
        reviewerProfileIds: z.array(z.string()).optional(),
        reviewerProfileReasons: z.array(z.string().trim().min(3).max(300)).max(12).optional(),
        maxRounds: z.number().int().min(1).max(5).optional(),
        gate: z.enum(["plan", "design"]).optional(),
      }).superRefine((stage, ctx) => {
        if (stage.profileReasons && stage.profileReasons.length !== stage.profileIds.length) {
          ctx.addIssue({
            code: "custom",
            path: ["profileReasons"],
            message: "Give one profile reason for each profileIds entry.",
          });
        }
        if (
          stage.reviewerProfileReasons
          && stage.reviewerProfileReasons.length !== (stage.reviewerProfileIds?.length ?? 0)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["reviewerProfileReasons"],
            message: "Give one reviewer reason for each reviewerProfileIds entry.",
          });
        }
      }),
    )
    .min(1)
    .max(12),
  risk: z.object({ level: z.enum(["low", "medium", "high"]), why: z.string().trim().min(3).max(300) }).optional(),
});

export const BriefResult = z.object({
  sourcePointers: SourcePointers,
  summary: z.string().min(3),
  forUsers: z.array(z.string()).default([]),
  areas: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1),
  risks: z.array(z.string()).default([]),
  // A blank answer is no answer: it goes back to the architect to fill in.
  answers: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(["accepted", "rejected"]),
        answer: z.string().trim().min(1),
        byCall: z.boolean().default(false),
      }),
    )
    .default([]),
});

const ReportImages = z
  .array(z.object({ path: z.string().trim().min(1), caption: z.string().trim().min(1) }))
  .max(12)
  .optional();

export const ObjectionsResult = z.object({
  images: ReportImages,
  objections: z.array(z.object({ text: z.string().min(3), blocking: z.boolean() })).default([]),
});

export const NotesResult = z.object({
  complete: z.boolean().optional(),
  images: ReportImages,
  summary: z.string().min(3),
  notes: z.array(z.string()).default([]),
});

/** What an agent learned about working in the repository, offered to the coordinator for AGENTS.md. */
const LEARNED = z
  .array(z.union([z.string(), z.object({ productId: z.string(), text: z.string() })]))
  .max(5)
  .default([]);

export const BuildResult = z.object({
  complete: z.boolean().optional(),
  images: ReportImages,
  summary: z.string().min(3),
  // One line for the commit that carries the whole change, in the repository's own style.
  title: z.string().trim().min(3).max(120).optional(),
  changes: z.array(z.string()).default([]),
  tests: z.string().optional(),
  // In a fix round: one answer per finding, by id.
  answers: z.array(z.object({ id: z.string(), fixed: z.boolean(), text: z.string().min(3) })).default([]),
  learnings: LEARNED,
  // A pull request's description, as Petrina publishes it.
  description: z.string().optional(),
});

/** GitHub's limits on what Petrina publishes. A pull request's description leaves room for Petrina's own part. */
export const TEXT_LIMITS = { title: 256, description: 60_000, body: 65_536, notes: 125_000 } as const;

/** The Release Manager's one job: a release's notes, across everything since the previous release. It changes no files. */
export const ReleaseNotesResult = z.object({
  summary: z.string().min(3),
  notes: z.string(),
});

export const CheckFinderResult = z.object({
  summary: z.string().min(3),
  checks: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(40),
        argv: z.array(z.string().min(1)).min(1).max(40),
        why: z.string().trim().min(3).max(200),
      }),
    )
    .min(1)
    .max(8),
});

export const GuideResult = z.object({
  missed: z.boolean(),
  line: z.string().trim().max(240).default(""),
  why: z.string().trim().min(3).max(400),
});

const AcceptanceCheckResult = z
  .union([
    z.object({
      productIds: z.array(z.string()).optional(),
      text: z.string(),
      result: z.enum(["pass", "fail", "blocked"]),
      reason: z.string().optional(),
      evidence: z.string().trim().min(3).max(1200).optional(),
    }),
    // Older saved agent sessions may still hand back the original pass/fail shape.
    z
      .object({
        text: z.string(),
        pass: z.boolean(),
        evidence: z.string().trim().min(3).max(1200).optional(),
      })
      .transform(({ text, pass, evidence }) => ({
        text,
        evidence,
        productIds: undefined as string[] | undefined,
        result: pass ? ("pass" as const) : ("fail" as const),
      })),
  ])
  .refine(
    (check) => check.result !== "blocked" || Boolean(check.reason?.trim()),
    "A blocked acceptance check needs a reason",
  );

export const TestResult = z.object({
  images: ReportImages,
  summary: z.string().min(3),
  checks: z.array(AcceptanceCheckResult).default([]),
  proofAnswers: z
    .array(
      z.object({
        id: z.string(),
        result: z.enum(["pass", "fail", "blocked"]),
        evidence: z.string().trim().min(3).max(1200).optional(),
        reason: z.string().trim().optional(),
      }),
    )
    .default([]),
  learnings: LEARNED,
});

export const ReviewResult = z
  .object({
    images: ReportImages,
    verdict: z.enum(["pass", "fail"]),
    proofRequests: z
      .array(
        z.object({
          text: z.string().trim().min(3),
          reason: z.string().trim().min(3),
          productIds: z.array(z.string()).min(1),
          checklistText: z.string().optional(),
        }),
      )
      .default([]),
    findings: z
      .array(
        z.object({
          text: z.string().min(3),
          productIds: z.array(z.string()).optional(),
          where: z.string().optional(),
          severity: z.enum(["important", "nit", "pre-existing"]),
          evidence: z.string().optional(),
          /** How to reproduce a confirmed older follow-up. */
          steps: z.string().optional(),
          /** An open follow-up card this is, or "none" when it is none of the cards shown. */
          sameBug: z.string().optional(),
        }),
      )
      .default([]),
    confirms: z
      .array(z.union([z.string(), z.object({ id: z.string(), evidence: z.string().trim().min(1) })]))
      .default([]),
    // A dispute always says why: the coordinator reads it next to the finding.
    disputes: z.array(z.object({ id: z.string(), reason: z.string().min(10) })).default([]),
    resolves: z.array(z.object({ id: z.string(), evidence: z.string().trim().min(10) })).default([]),
    learnings: LEARNED,
  })
  .transform(({ confirms, ...result }) => ({
    ...result,
    confirms: [...new Set(confirms.map((entry) => (typeof entry === "string" ? entry : entry.id)))],
    confirmationEvidence: Object.fromEntries(
      confirms.flatMap((entry) => (typeof entry === "string" ? [] : [[entry.id, entry.evidence]])),
    ) as Record<string, string>,
  }));

export const VerifyResult = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(["real", "not-a-bug", "nit", "pre-existing"]),
        reason: z.string().min(10),
      }),
    )
    .min(1),
});
