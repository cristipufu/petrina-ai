// Shared identity for durable receipts and bounded evidence continuations.
import { createHash } from "node:crypto";

export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
