import type { MessageClock } from "./agent-messages.js";

/** Native batching has the same one-second deadline used by ACP message streams. */
export const messageClock: MessageClock = {
  after(ms, work) {
    const timer = setTimeout(work, ms);
    return () => clearTimeout(timer);
  },
};
