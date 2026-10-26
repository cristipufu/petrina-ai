import type { CheckRun, ProductCheck } from "./model.js";

const OUTPUT_KEPT = 6000;

/** Plain text for the window: no colour codes, only the end of long output. */
export function tidyOutput(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal colour codes
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
  return plain.length > OUTPUT_KEPT ? `…\n${plain.slice(-OUTPUT_KEPT)}` : plain;
}

export function commandText(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

/** Literal text for editable command input; display/record identities use commandText instead. */
export function commandInputText(argv: readonly string[]): string {
  return argv.map(part => !part || /[\s'"]/.test(part) ? `'${part.replaceAll("'", `'"'"'`)}'` : part).join(" ");
}

/** Split a command the coordinator typed into arguments, honouring quotes. Never run through a shell. */
export function parseCommand(text: string): string[] {
  const argv: string[] = [];
  let word = "";
  let quote: string | undefined;
  let inWord = false;
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) argv.push(word);
  return argv;
}

/** Recognise conventional static commands; opaque commands keep their declared order. */
export function staticCheck(check: ProductCheck): boolean {
  return /^(?:type[ -]?check|lint)(?:\s|$)/i.test(check.name)
    || check.argv.some((arg) => /^(?:typecheck|type-check|lint|eslint|biome|clippy|mypy|pyright)$/.test(arg))
    || (check.argv.some((arg) => /(?:^|[\\/])tsc(?:\.cmd)?$/.test(arg)) && check.argv.includes("--noEmit"));
}

export function orderedChecks(checks: readonly ProductCheck[]): ProductCheck[] {
  const commands = checks.filter((check) => check.argv.length);
  return [...commands.filter(staticCheck), ...commands.filter((check) => !staticCheck(check))];
}

/** An early static failure is complete failing evidence; skipped work never counts as a pass. */
export function expectedCheckCommands(checks: readonly ProductCheck[], results: readonly CheckRun[]): string[] {
  const ordered = orderedChecks(checks);
  const failed = ordered.findIndex((check) => staticCheck(check) && results.some((run) => !run.ok && run.command === commandText(check.argv)));
  return (failed < 0 ? ordered : ordered.slice(0, failed + 1)).map((check) => commandText(check.argv));
}

/** Whether two sets of checks run the same commands (names and reasons aside). */
export function sameCommands(a: readonly ProductCheck[], b: readonly ProductCheck[]): boolean {
  return a.length === b.length && a.every((check, index) => commandText(check.argv) === commandText(b[index]!.argv));
}
