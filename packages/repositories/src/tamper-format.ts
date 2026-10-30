/** Git --raw -z --patch: NUL-framed records, an empty separator, then untouched patch text. */
export function parseTamperPacket(text: string): { deleted: string[]; patch: string } {
  if (!text) return { deleted: [], patch: "" };
  const deleted: string[] = [];
  let offset = 0;
  const field = () => {
    const end = text.indexOf("\0", offset);
    if (end < 0) throw new Error("Git returned an incomplete tamper comparison");
    const value = text.slice(offset, end); offset = end + 1;
    return value;
  };
  while (offset < text.length) {
    const header = field();
    if (!header) return { deleted, patch: text.slice(offset) };
    const record = /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ ([ACDMRTUX])\d*$/.exec(header);
    if (!record) throw new Error("Git returned an invalid tamper comparison");
    const name = field();
    if (!name) throw new Error("Git returned an empty tamper comparison path");
    if (record[1] === "D") deleted.push(name);
    if (record[1] === "R" || record[1] === "C") {
      if (!field()) throw new Error("Git returned an empty tamper comparison path");
    }
  }
  throw new Error("Git returned an incomplete tamper comparison");
}

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$/i;
const SKIP_MARKERS = /^\+.*(\b(it|test|describe)\.(skip|only)\(|\bxit\(|\bxdescribe\(|@(Disabled|Ignore)\b|pytest\.mark\.skip|#\[ignore\]|\.todo\()/;

/** Keep the established command-output normalization, line matching and report ordering. */
export function tamperProblems(deleted: readonly string[], patch: string): string[] {
  const problems: string[] = [];
  // The former name-only command normalized its entire output before splitting NUL-delimited names.
  const removed = deleted.map(name => name + "\0").join("").trim().split("\0").filter(Boolean);
  for (const file of removed) if (TEST_FILE.test(file)) problems.push(`A test file was deleted: ${file}`);
  let file = "";
  for (const line of patch.trim().split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (SKIP_MARKERS.test(line)) problems.push(`A test was skipped or narrowed in ${file}`);
  }
  return [...new Set(problems)];
}
