import { expect, it } from "bun:test";
import { AgentMessages, type AgentMessage } from "../src/agent-messages.js";
import { waitFor } from "./support.js";

it("publishes public text while a turn is still running, coalescing token chunks into one bubble", async () => {
  const seen: AgentMessage[] = [];
  const messages = new AgentMessages((message) => seen.push(message));
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

it("separates harness message ids and messages around tools, without inserting spaces inside token chunks", () => {
  const seen: AgentMessage[] = [];
  const messages = new AgentMessages((message) => seen.push(message));
  messages.push("First up", "first");
  messages.push("date.", "first");
  messages.push("Final result.", "second");
  messages.boundary();
  messages.push("Without an id.");
  messages.activity();
  messages.push("After a tool.");
  messages.boundary();
  expect(seen.map((message) => message.text)).toEqual(["First update.", "Final result.", "Without an id.", "After a tool."]);
  expect(new Set(seen.map((message) => message.id)).size).toBe(4);
});

it("never streams an unfinished structured result or code, and keeps long public text bounded", () => {
  const seen: AgentMessage[] = [];
  const messages = new AgentMessages((message) => seen.push(message));
  messages.push("The checks pass.\n``", "result");
  messages.flush();
  expect(seen[0]!.text).toBe("The checks pass.");
  messages.push('`petrina\n{"verdict":', "result");
  messages.flush();
  messages.push('"pass"}\n```', "result");
  messages.boundary();
  messages.push("x".repeat(20_000), "long");
  messages.boundary();
  expect(seen[0]!.text).toBe("The checks pass.");
  expect(seen).toHaveLength(2);
  expect(seen[1]!.text.length).toBeLessThan(2500);
  expect(seen.some((message) => message.text.includes("verdict"))).toBe(false);
});
