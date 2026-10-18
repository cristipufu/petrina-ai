import { z } from "zod";

export const StartFromSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("branch"), name: z.string().trim().min(1).max(255) }),
  z.object({ kind: z.literal("pull-request"), value: z.string().trim().min(1).max(500) }),
]);
export const WorkChoiceSchema = z.object({ productId: z.string(), startFrom: StartFromSchema, delivery: z.enum(["pull-request", "release", "local"]) });
