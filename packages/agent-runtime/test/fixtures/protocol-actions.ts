import * as acp from "@agentclientprotocol/sdk";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type NativeStep =
  | { update: acp.SessionNotification["update"] }
  | { notice: { method: string; params: Record<string, unknown> } }
  | { wait: string }
  | { mark: string }
  | { permission: string }
  | { fail: { code: number; message: string; data?: unknown } };
export interface NativePrompt { steps: NativeStep[]; reply?: string; late?: NativeStep[]; meta?: Record<string, unknown> }
export interface ProtocolHistory { history: acp.SessionNotification["update"][]; notices: { method: string; params: Record<string, unknown> }[] }

/** Native protocol primitives only: the peer owns no task, workflow role or repository. */
export async function protocolActions(client: acp.AgentContext, sessionId: string, steps: readonly NativeStep[], record: ProtocolHistory, keep: () => void) {
  const name = (file: string) => join(process.cwd(), file.replaceAll("{session}", sessionId));
  for (const step of steps) {
    if ("update" in step) {
      record.history.push(step.update); keep();
      await client.notify(acp.methods.client.session.update, { sessionId, update: step.update });
    } else if ("notice" in step) {
      const params = { sessionId, ...step.notice.params };
      record.notices.push({ method: step.notice.method, params }); keep();
      await client.notify(step.notice.method as typeof acp.methods.client.session.update, params as never);
    } else if ("wait" in step) { while (!existsSync(name(step.wait))) await Bun.sleep(20); }
    else if ("mark" in step) writeFileSync(name(step.mark), "");
    else if ("permission" in step) {
      await client.request(acp.methods.client.session.requestPermission, { sessionId,
        toolCall: { toolCallId: `native-permission-${sessionId}`, title: step.permission, kind: "execute", status: "pending" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
      });
    } else throw new acp.RequestError(step.fail.code, step.fail.message, step.fail.data);
  }
}
