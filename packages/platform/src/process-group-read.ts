import { processList } from "./process-tree.js";
import { parseProcessGroupMembers, type ProcessGroupMember } from "./process-group-snapshots.js";

/** The bounded native observation uses a stable locale for POSIX birth identities. */
export async function readProcessGroupMembers(timeout: number): Promise<ProcessGroupMember[] | undefined> {
  const list = await processList(["-A", "-o", "pid=,pgid=,stat=,lstart=,command="], timeout, undefined, { ...process.env, LC_ALL: "C" });
  return list === undefined ? undefined : parseProcessGroupMembers(list);
}
