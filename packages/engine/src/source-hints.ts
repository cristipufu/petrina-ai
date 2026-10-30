export { checkSourceHints } from "@petrina/orchestrator";
import { z } from "zod";

/** One optional navigation location. Each is checked on its own, so a bad entry never costs an agent's result. */
export const SourcePointerEntry = z
  .object({
    productId: z.string().min(1).max(100),
    revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
    path: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine(
        (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
        "Use a repository-relative location",
      ),
  })
  .strict();
