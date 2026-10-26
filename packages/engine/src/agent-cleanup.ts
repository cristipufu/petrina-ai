import { CleanupReceipts, type AgentSession } from "@petrina/orchestrator";

/** Native ownership is independent of the maps used to display or charge running seats. */
export class AgentCleanup extends CleanupReceipts {
  private readonly sessions = new WeakMap<AgentSession, { owner: object; resource: string }>();

  opening(taskId: string, resource: string) {
    const owner = {};
    return {
      onGone: (gone: Promise<void>) => this.observe(taskId, owner, gone, resource),
      onCleanupIncomplete: () => this.incomplete(taskId, owner, resource),
      attach: (session: AgentSession) => this.sessions.set(session, { owner, resource }),
    };
  }

  stop(taskId: string, session: AgentSession): Promise<void> {
    const owned = this.sessions.get(session);
    return this.request(taskId, owned?.owner ?? session, () => session.stop(), owned?.resource);
  }
}
