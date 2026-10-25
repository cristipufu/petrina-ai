import type { DeepMutable } from "./flow.js";
import type { Task } from "./model.js";

export const MAX_SESSION_LINES = 800;
type SessionLine = DeepMutable<Task["session"][number]>;

/** Preserve reports until their pictures arrive, and the latest words for every participant/product. */
export function appendSessionLine(session: SessionLine[], line: SessionLine, pendingReportIds: ReadonlySet<string>, maximum = MAX_SESSION_LINES): void {
  session.push(line);
  while (session.length > maximum) {
    const index = session.findIndex((line, index) => index < session.length - 1 && !line.images?.length && !pendingReportIds.has(line.id)
      && (line.from !== "agent" || session.some((other, later) => later > index && other.from === "agent" && other.roleId === line.roleId && other.profileId === line.profileId && other.productId === line.productId)));
    if (index < 0) break;
    session.splice(index, 1);
  }
}
