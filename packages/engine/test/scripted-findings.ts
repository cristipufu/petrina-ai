/** The body of a section in an actual engine prompt, including expanded context packets. */
export function promptSection(text: string, title: string): string | undefined {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return undefined;
  const body = text.slice(start + title.length + 4);
  const end = body.indexOf("\n## ");
  return (end < 0 ? body : body.slice(0, end)).trim();
}

export function findingIds(text: string, title: string): string[] {
  return [...(promptSection(text, title) ?? "").matchAll(/^- \[([^\]]+)\]/gm)].map(match => match[1]!);
}

/** Scripted builders answer the IDs actually supplied by the engine, never saved task internals. */
export function answersTo(text: string, answer: { fixed: boolean; text: string } = { fixed: true, text: "Fixed it." }) {
  const index = promptSection(text, "Current finding status index");
  const ids = index !== undefined ? [...index.matchAll(/^- ([^:\n]+): open,/gm)].map(match => match[1]!)
    : findingIds(text, "Review findings (answer every one by id; fix every Important one)");
  return ids.map(id => ({ id, ...answer }));
}
