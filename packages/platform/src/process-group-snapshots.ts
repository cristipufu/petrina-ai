/** Completed POSIX group observations. Birth identity is opaque to the caller. */
export interface ProcessGroupMember {
  pid: number;
  group: number;
  state: "running" | "defunct";
  command: string;
  birthIdentity?: string;
}

/** Interpret ps pid/pgid/stat/lstart/command output without changing incomplete-row behavior. */
export function parseProcessGroupMembers(list: string): ProcessGroupMember[] {
  return list.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) return [];
    const identity = match[4]?.match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.+))?$/);
    return [{ pid: Number(match[1]), group: Number(match[2]), state: match[3]!.startsWith("Z") ? "defunct" as const : "running" as const,
      command: identity ? identity[2] ?? "" : match[4] ?? "",
      ...(identity ? { birthIdentity: identity[1]!.replace(/\s+/g, " ") } : {}) }];
  });
}
