import type { ToolAdapter } from "./tool-adapter.js";

type LiveInput = NonNullable<ToolAdapter["liveInput"]>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

export const steering = (hostIdle: boolean): LiveInput => ({
  supported: init => object(object(object(init)._meta).steering).supported === true,
  request: (sessionId, text) => ({ method: "_session/steering", params: {
    sessionId, prompt: [{ type: "text", text }],
    ...(hostIdle ? { _meta: { steering: { idleBehavior: "promptRequired" } } } : {}),
  } }),
  receipt: response => {
    switch (object(response).outcome) {
      case "injected": return "current-turn";
      case "startedNewTurn": return "separate-turn";
      case "promptRequired": return hostIdle ? "prompt-required" : "rejected";
      default: return "rejected";
    }
  },
});

export const interjection: LiveInput = {
  // This native server has no interject capability flag. Verify method recognition using
  // a nonexistent session, without opening a session or spending a model turn.
  supported: () => true,
  probe: {
    method: "_x.ai/interject",
    params: { sessionId: "00000000-0000-4000-8000-000000000000", text: "Capability check on a nonexistent session" },
    recognizedError: error => object(error).code === -32602 && /session not found/i.test(JSON.stringify(object(error).data)),
  },
  request: (sessionId, text, messageId) => ({ method: "_x.ai/interject", params: { sessionId, text, interjectionId: messageId } }),
  receipt: response => object(response).status === "queued" ? "accepted" : "rejected",
};
