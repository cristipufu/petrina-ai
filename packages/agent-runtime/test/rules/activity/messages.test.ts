import { expect, it } from "bun:test";
import { AgentMessages } from "../../../src/agent-messages.js";
import type { AgentMessage } from "@petrina/orchestrator";
import { messageClockFixture } from "../../fixtures/message-clock.js";

it("separates harness message ids and messages around tools, without inserting spaces inside token chunks", () => {
  const seen: AgentMessage[] = [];
  const { clock } = messageClockFixture();
  const messages = new AgentMessages(clock, (message) => seen.push(message));
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
  const { clock } = messageClockFixture();
  const messages = new AgentMessages(clock, (message) => seen.push(message));
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

it("keeps one pending batch, publishes at its deadline and cancels sealed boundaries", () => {
  const seen: AgentMessage[] = [];
  const timer = messageClockFixture();
  const messages = new AgentMessages(timer.clock, message => seen.push(message));
  messages.push("First", "one"); messages.push(" chunk.", "one");
  expect(timer.pending()).toBe(1);
  timer.advance(999);
  expect(seen).toEqual([]);
  timer.advance(1);
  expect(seen.map(message => message.text)).toEqual(["First chunk."]);
  expect(timer.pending()).toBe(0);
  messages.push(" More.", "one");
  expect(timer.pending()).toBe(1);
  messages.boundary();
  expect(timer.pending()).toBe(0);
  expect(seen.at(-1)?.text).toBe("First chunk. More.");
  timer.advance(1000);
  expect(seen).toHaveLength(2);
});
