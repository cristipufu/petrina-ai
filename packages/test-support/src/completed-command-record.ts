/** A completed owned command's retained output; process and pipe ownership stay with its runner. */
export interface CompletedCommandOutput { code: number; stdout: string; outputRetained?: false }

/** A framed JSON record is evidence only after a successful exit and complete retained output. */
export function completedCommandRecord(result: CompletedCommandOutput, prefix: string): unknown {
  if (result.code !== 0) throw new Error(`The command exited with ${result.code}; its result is unavailable`);
  if (result.outputRetained === false) throw new Error("The command output was not retained");
  if (!prefix) throw new Error("A command result needs a nonempty record prefix");
  const lines = result.stdout.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error("The command did not return exactly one completed result record");
  return JSON.parse(lines[0]!.slice(prefix.length)) as unknown;
}
