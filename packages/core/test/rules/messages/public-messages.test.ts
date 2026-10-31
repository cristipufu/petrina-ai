import { expect, it } from "vitest";
import {
  AgentMessages,
  CONVERSATION_PAGE_LENGTH,
  createDemoState,
  immediateMessageClock,
  previewRecord,
  PUBLIC_BATCH_BYTES,
  PUBLIC_MESSAGE_BYTES,
  recordingNotice,
  Simulator,
  TurnText,
  utf8ByteLength,
  type AgentMessage,
} from "../../../src/index.js";

it("records new demo agent messages with known completeness and pages long demo updates", () => {
  const sim = new Simulator(createDemoState(1_000_000));
  sim.tick();
  const state = sim.getState();
  const task = state.tasks.find((entry) => entry.session.some((line) => line.from === "agent" && line.recording))!;
  const line = task.session.find((entry) => entry.from === "agent" && entry.recording)!;
  expect(line.recording).toMatchObject({
    complete: true,
    state: "finished",
    recordedLength: line.text.length,
    originalLength: line.text.length,
  });
  expect(recordingNotice(line.recording!)).toBeUndefined();
  const longText = "Demo paragraph. ".repeat(3000);
  const longLine = {
    id: "long-demo",
    at: 2,
    from: "agent" as const,
    text: longText,
    recording: {
      recordedLength: longText.length,
      originalLength: longText.length,
      complete: true,
      state: "finished" as const,
      revision: 1,
    },
  };
  const pagedSim = new Simulator({
    ...state,
    tasks: state.tasks.map((entry) =>
      entry.id === task.id ? { ...entry, session: [...entry.session, longLine] } : entry,
    ),
  });
  const first = pagedSim.publicMessage(task.id, "long-demo", 0, CONVERSATION_PAGE_LENGTH)!;
  expect(first.text.length).toBe(CONVERSATION_PAGE_LENGTH);
  expect(first.next).toBe(CONVERSATION_PAGE_LENGTH);
  const second = pagedSim.publicMessage(task.id, "long-demo", first.next!, CONVERSATION_PAGE_LENGTH)!;
  expect(first.text + second.text).toBe(longText);
  expect(second.next).toBeUndefined();
});

it("labels recognizable older shortening, while treating other ellipses and completeness as unknown", () => {
  const old = previewRecord({ from: "agent", text: `${"a".repeat(2400)}…` });
  expect(old.text).toHaveLength(2400);
  expect(old.recording).toMatchObject({ complete: false, originalLength: null, reason: "legacy-truncated" });
  expect(recordingNotice(old.recording)).toContain("ending was not recorded");
  expect(previewRecord({ from: "agent", text: `${"a".repeat(2399)}\uD83D…` }).text).toHaveLength(2399);
  for (const text of ["An ordinary message…", "a".repeat(2400), "Short public text."]) {
    expect(previewRecord({ from: "agent", text }).recording).toMatchObject({
      complete: null,
      originalLength: null,
      reason: "legacy-unknown",
    });
  }
  expect(previewRecord({ from: "you", text: "Coordinator note" }).recording).toMatchObject({
    complete: true,
    originalLength: 16,
  });
});

it("counts overflow without buffering it, keeps exact byte limits, and still processes structured results", () => {
  const seen: AgentMessage[] = [];
  const messages = new AgentMessages(immediateMessageClock, (message) => seen.push(message));
  const result = new TurnText();
  const chunk = "😀é中\n".repeat(1000);
  let original = 0;
  for (let index = 0; index < 80; index++) {
    messages.push(chunk, "long");
    result.push(chunk);
    original += chunk.length;
    expect(messages.bufferedBytes).toBeLessThanOrEqual(PUBLIC_BATCH_BYTES + 8);
    expect(result.text.length).toBeLessThanOrEqual(1200);
  }
  const fence = '```petrina\n{"ok":true}\n```';
  for (const part of ["`", "`", fence.slice(2)]) {
    messages.push(part, "long");
    result.push(part);
  }
  messages.boundary();
  const saved = seen.map((message) => message.delta).join("");
  expect(utf8ByteLength(saved)).toBeLessThanOrEqual(PUBLIC_MESSAGE_BYTES);
  expect(utf8ByteLength(saved)).toBeGreaterThan(PUBLIC_MESSAGE_BYTES - 4);
  expect(seen.at(-1)).toMatchObject({ originalLength: original, limited: true, ended: true });
  expect(seen.every((message) => utf8ByteLength(message.delta ?? "") <= PUBLIC_BATCH_BYTES)).toBe(true);
  expect(seen.length).toBeLessThanOrEqual(Math.ceil(PUBLIC_MESSAGE_BYTES / PUBLIC_BATCH_BYTES) + 2);
  expect(saved).not.toContain("petrina");
  expect(result.text).toContain('```petrina\n{"ok":true}\n```');
});

it("withholds split Unicode and fences, and revises text beyond a fixed preview", () => {
  const seen: AgentMessage[] = [];
  const messages = new AgentMessages(immediateMessageClock, (message) => seen.push(message));
  messages.push(`${"a".repeat(2399)}\uD83D`, "unicode");
  messages.flush();
  expect(seen[0]!.text).toHaveLength(2399);
  messages.push("\uDE00 finish", "unicode");
  messages.flush();
  expect(seen[1]!.text).toBe(seen[0]!.text);
  expect(seen[1]!.originalLength).toBe(2408);
  messages.push("`", "unicode");
  messages.flush();
  messages.push("`", "unicode");
  messages.flush();
  messages.push('`json\n{"private":true}', "unicode");
  messages.flush();
  messages.boundary();
  expect(seen.map((message) => message.delta).join("")).toBe(`${"a".repeat(2399)}😀 finish`);
  expect(seen.at(-1)!.ended).toBe(true);
});

it("discards code and later ordinary text from the turn buffer, while retaining the last structured result", () => {
  const turn = new TurnText();
  turn.push("Public opening.\n```typescript\n");
  for (let index = 0; index < 100; index++) turn.push("private code\n".repeat(1000));
  turn.push("```\n");
  for (let index = 0; index < 100; index++) turn.push("More ordinary prose. ".repeat(1000));
  expect(turn.text).toBe("Public opening.\n");
  for (const part of ["`", "``pet", "rina\n", '{"ok":false}', "```", "```json\n", '{"ok":true}', "`", "``"]) {
    turn.push(part);
  }
  expect(turn.text).toContain('```json\n{"ok":true}```');
  expect(turn.text.length).toBeLessThan(100);
  expect(turn.ending.length).toBeLessThan(1300);
});

it.each([30, 48_000])(
  "keeps a complete %s-character structured reply through split chunks without public prose",
  (length) => {
    const turn = new TurnText();
    const seen: AgentMessage[] = [];
    const messages = new AgentMessages(immediateMessageClock, (message) => seen.push(message));
    const value = { evidence: "x".repeat(length), complete: true };
    const body = JSON.stringify(value);
    for (const text of ["`", "``pet", "rina\n", body.slice(0, 1000), body.slice(1000), "`", "``"]) {
      turn.push(text);
      messages.push(text);
    }
    messages.boundary();
    const match = /```petrina\n([\s\S]*?)```/.exec(turn.text);
    expect(JSON.parse(match![1]!)).toEqual(value);
    expect(seen).toEqual([]);
  },
);

it("preserves exact paragraph spacing between short public prose and a structured result block", () => {
  const turn = new TurnText();
  const reply = 'The work is finished.\n\n```petrina\n{"summary":"Done"}\n```';
  turn.push(reply);
  expect(turn.text).toBe(reply);
});
