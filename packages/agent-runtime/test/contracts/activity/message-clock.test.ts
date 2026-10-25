import { expect, it } from "bun:test";
import { AgentMessages } from "../../../src/agent-messages.js";
import type { AgentMessage } from "@petrina/orchestrator";
import { messageClock } from "../../../src/message-clock.js";
import { waitFor } from "@petrina/test-support/fixtures";

it("publishes public text while a turn is still running, coalescing token chunks into one bubble", async () => {
  const seen: AgentMessage[] = [];
  const messages = new AgentMessages(messageClock, (message) => seen.push(message));
  try {
    messages.push("I'm checking ", "opening");
    messages.push("the nearby cases.", "opening");
    expect(seen).toEqual([]);
    await waitFor(() => seen.length === 1, "the live message batch", 3000);
    expect(seen[0]!.text).toBe("I'm checking the nearby cases.");
    messages.activity();
    messages.push(" One case needs a fix.", "opening");
    messages.flush();
    expect(seen[1]!.id).toBe(seen[0]!.id);
    expect(seen[1]!.text).toContain("One case needs a fix.");
  } finally { messages.boundary(); }
});
