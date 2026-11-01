import { z } from "zod";
import { DELIVERY_MODES } from "@petrina/core";

export const DeliveryModeSchema = z.enum(DELIVERY_MODES);

export const StartFromSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("branch"), name: z.string().trim().min(1).max(255) }),
  z.object({ kind: z.literal("pull-request"), value: z.string().trim().min(1).max(500) }),
]);
export const WorkChoiceSchema = z.object({
  productId: z.string(),
  startFrom: StartFromSchema,
  delivery: DeliveryModeSchema,
  repo: z.string().max(300).optional(),
  reason: z.string().max(1000).optional(),
  builderProfileId: z.string().optional(),
  lead: z.boolean().optional()
});
