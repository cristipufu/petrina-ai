import { createLimitParsing } from "../../src/provider-refusals.js";
import { claudeLimit, codexLimit, grokLimit } from "../../src/provider-limits.js";

/** Actual pure parsers with explicit provider metadata; registry composition has separate controls. */
const providers = {
  "claude-code": { name: "Claude Code", parseLimitError: claudeLimit },
  codex: { name: "Codex", parseLimitError: codexLimit },
  grok: { name: "Grok", parseLimitError: grokLimit },
};
export const { limitFromFailure, limitFromReport } = createLimitParsing(id => providers[id as keyof typeof providers]);
