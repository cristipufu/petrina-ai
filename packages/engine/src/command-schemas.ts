// Shared wire schemas reused across the window RPC server (server.ts) and the coordinator catalogue (operations.ts).
import { z } from "zod";
import {
  EFFORTS,
  RELEASE_BUMPS,
  ROLE_ICON_CHOICES,
  ROLE_LIMITS,
  ROLE_RESULTS,
  TONE_CHOICES,
  type ProductSettings,
  type RoutineDraft,
  type RoutineSchedule,
} from "@petrina/core";
import { DeliveryModeSchema, StartFromSchema, WorkChoiceSchema } from "./source-schema.js";

export const WireIdSchema = z.string().min(1).max(200);
export const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const TaskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const TaskKindSchema = z.enum(["new", "feature", "bug", "chore"]);
export const ScreenModeSchema = z.enum(["off", "hour", "on"]);
export const AnalyticsPeriodSchema = z.enum(["today", "7d", "30d"]);
export const StageProfileListSchema = z.enum(["profileIds", "reviewerProfileIds"]);
export const ReleaseBumpSchema = z.enum(RELEASE_BUMPS);

export const CheckSetupRequirementsSchema = z
  .array(
    z
      .object({
        id: WireIdSchema,
        name: z.string().min(1).max(40),
        argv: z.array(z.string()).min(1),
      })
      .strict(),
  )
  .max(12);

export const ProductChecksInputSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(40),
        command: z.string().min(1).max(500),
      })
      .strict(),
  )
  .max(12)
  .nullable();

export const ProductRemoteChecksSchema = z.array(z.string().min(1).max(120)).max(20);

export const ProductSettingsFields = {
  name: z.string(),
  delivery: DeliveryModeSchema,
  approveDelivery: z.boolean(),
  shipLowRisk: z.boolean().optional(),
  releaseBump: ReleaseBumpSchema.optional(),
} as const;

export const ProductSettingsSchema = z.object(ProductSettingsFields) satisfies z.ZodType<ProductSettings>;

export const BacklogUpdateFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000),
} as const;

export const BacklogUpdateSchema = z.object(BacklogUpdateFields);

export const RoutineScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: z.string() }),
  z.object({
    kind: z.literal("weekly"),
    time: z.string(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  }),
  z.object({ kind: z.literal("cron"), expression: z.string().max(200) }),
]) satisfies z.ZodType<RoutineSchedule>;

export const RoutineDraftFields = {
  name: z.string().max(100),
  productId: z.string(),
  roleId: z.string(),
  profileId: z.string(),
  focus: z.string().max(4000),
  zone: z.string().max(100),
  enabled: z.boolean(),
  schedule: RoutineScheduleSchema,
} as const;

export const RoutineDraftSchema = z.object(RoutineDraftFields) satisfies z.ZodType<RoutineDraft>;

export const RoleDraftSchema = z.object({
  category: z.enum(["workflow", "maintenance"]).optional(),
  name: z.string().max(ROLE_LIMITS.name * 10),
  icon: z.enum(ROLE_ICON_CHOICES),
  tone: z.enum(TONE_CHOICES),
  purpose: z.string().max(ROLE_LIMITS.purpose * 10),
  instructions: z.string().max(ROLE_LIMITS.instructions * 10),
  canEdit: z.boolean(),
  handsBack: z.string().max(ROLE_LIMITS.handsBack * 10),
  result: z.enum(ROLE_RESULTS),
});

export const ProfileDraftSchema = z
  .object({
    toolId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    effort: z.enum(EFFORTS),
    standby: z.boolean().optional(),
  })
  .strict();

export const NewTaskWindowSchema = z.object({
  backlog: z.boolean().optional(),
  after: z.array(TaskIdSchema).max(20).optional(),
  worksOn: z.array(WorkChoiceSchema).max(20).optional(),
  startFrom: StartFromSchema.optional(),
  productId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  kind: TaskKindSchema.optional(),
  position: z.enum(["top", "bottom"]).optional(),
  approvePlan: z.boolean().optional(),
  delivery: DeliveryModeSchema.optional(),
  approveDelivery: z.boolean().optional(),
  clientId: ClientIdSchema.optional(),
});
