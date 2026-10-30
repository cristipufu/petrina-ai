/** Duration hints order discovered files; they never select tests or prove a passing check. */
export interface TestTimingHints { version: 1; files: Record<string, number> }

export function testTimingHints(body: string, expected: readonly string[]): TestTimingHints | undefined {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const hints = value as Partial<TestTimingHints>;
  if (hints.version !== 1 || !hints.files || typeof hints.files !== "object" || Array.isArray(hints.files)) return;
  const known = new Set(expected.map(file => file.replaceAll("\\", "/").replace(/^\.\//, "")));
  const seen = new Set<string>();
  const files: Record<string, number> = Object.create(null);
  for (const [file, ms] of Object.entries(hints.files)) {
    if (!file || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
    const name = file.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!known.has(name)) continue;
    if (seen.has(name)) return;
    seen.add(name);
    // Retain the spelling Bun itself wrote, including native Windows separators.
    files[file] = ms;
  }
  return seen.size ? { version: 1, files } : undefined;
}
