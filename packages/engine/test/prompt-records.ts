// Private fake-agent evidence, shared by several processes. Never append large prompts to one file:
// an observer can read a short write, and another writer can append between its pieces.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptRecord { role: string; session: string; text: string }

function lastRecord(folder: string): number {
  return readdirSync(folder).reduce((last, name) => /^[1-9]\d*$/.test(name) ? Math.max(last, Number(name)) : last, 0);
}

/** Publish only after writing and closing the complete record. `write` lets regressions hold a short write. */
export async function recordPrompt(dir: string, record: PromptRecord, write: (path: string, text: string) => void | Promise<void> = writeFileSync): Promise<void> {
  const folder = join(dir, "prompts");
  mkdirSync(folder, { recursive: true });
  let sequence = lastRecord(folder) + 1;
  const pending = join(folder, `.pending-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(pending);
  try {
    await write(join(pending, "prompt.json"), JSON.stringify(record));
    const deadline = performance.now() + 30_000;
    for (;;) {
      const destination = join(folder, String(sequence));
      try {
        // Renaming the complete directory publishes its contents together. Existing destinations are
        // nonempty, so a concurrent writer cannot replace them; it takes the next sequence instead.
        renameSync(pending, destination);
        return;
      } catch (error) {
        if (!existsSync(destination) || performance.now() >= deadline) throw error;
        sequence += 1;
      }
    }
  } finally {
    // An interrupted process can leave only a private pending directory, reclaimed with its fixture.
    rmSync(pending, { recursive: true, force: true });
  }
}

export function readPrompts(dir: string): PromptRecord[] {
  const folder = join(dir, "prompts");
  if (!existsSync(folder)) return [];
  // Bound this observation to a published sequence. Read its entire prefix even if readdir races with
  // more publications; a pending write never reserves a number or blocks another participant.
  const last = lastRecord(folder);
  return Array.from({ length: last }, (_, index) => JSON.parse(readFileSync(join(folder, String(index + 1), "prompt.json"), "utf8")) as PromptRecord);
}
