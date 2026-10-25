// Pure metadata projection for the local protocol; no client or stdio is opened.
import { z } from "zod";
import { OPERATIONS } from "./operations.js";

export const toolName = (name: string) => `petrina_${name.replace(/[.-]/g, "_")}`;
export const mcpTools = () =>
  OPERATIONS.map((op) => ({
    name: toolName(op.name),
    description: op.description,
    inputSchema: z.toJSONSchema(op.schema),
    outputSchema: { type: "object", properties: { outcome: { type: "string" } }, required: ["outcome"], additionalProperties: true },
    // Changes can replace settings, interrupt work and authorize publishing. Do not claim
    // additive-only effects or a closed system to the calling agent's safety checker.
    annotations: { readOnlyHint: !op.changes, idempotentHint: op.changes },
  }));
