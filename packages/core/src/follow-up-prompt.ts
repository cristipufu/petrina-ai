import type { MatchAsk } from "./follow-ups.js";

export function matchPrompt(ask: MatchAsk): string {
  const cards = ask.cards.length
    ? ask.cards.map((card) => `- Card [${card.id}]: ${card.title}\n  Problem: ${card.problem}\n  Products: ${card.productIds.join(", ") || "any"}`).join("\n")
    : "None.";
  const reports = ask.reports.map((report) => `- Report [${report.key}]\n  Problem: ${report.text}\n  Steps: ${report.steps}\n  Evidence: ${report.evidence}\n  Found by: ${report.raisedBy}\n  Products: ${report.productIds.join(", ") || "any"}`).join("\n");
  return `Which older reports are the same bug?

Group the reports that describe one bug, even when the words differ. Put a report on an open card only when it is that bug. A report you cannot place goes under uncertain, and not in a group. Do not invent a card id.
Compare only the supplied text. Do not use tools, read files, run commands, change anything or contact services. If the text is insufficient, say uncertain.

Open follow-up cards:
${cards}

Reports:
${reports}

When you are done, end with one petrina block:
\`\`\`petrina
{"groups":[{"keys":["report key"],"cardId":"card id"}],"uncertain":["report key"]}
\`\`\``;
}
