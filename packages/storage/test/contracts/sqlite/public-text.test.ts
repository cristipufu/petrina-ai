import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import {
  AgentMessages,
  immediateMessageClock,
  previewRecord,
  PUBLIC_MESSAGE_BYTES,
  PUBLIC_TASK_BYTES,
  type SessionLine,
} from "@petrina/core";
import { PublicText } from "@petrina/storage/public-text";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("CREATE TABLE active_tasks (id TEXT PRIMARY KEY,body TEXT)");
  db.run("CREATE TABLE task_history (id TEXT PRIMARY KEY,body TEXT)");
  const store = new PublicText(db);
  const lines: SessionLine[] = [];
  const stream = (taskId = "task") => {
    const own = new Map<number, SessionLine>();
    return new AgentMessages(immediateMessageClock, (message) => {
      let line = own.get(message.id);
      if (!line) {
        line = { id: `${taskId}-${lines.length}`, at: 1, from: "agent", text: message.text };
        lines.push(line);
        own.set(message.id, line);
      }
      line.text = message.text;
      const saved = store.append(taskId, line, message);
      line.recording = saved.recording;
      return saved.accepting;
    });
  };
  return { db, store, lines, stream };
}

it("records an exact message allowance and counts the unsaved ending without changing saved text", () => {
  const f = fixture();
  const messages = f.stream();
  messages.push("a".repeat(PUBLIC_MESSAGE_BYTES), "long");
  messages.flush();
  const line = f.lines[0]!;
  expect(f.store.read("task", line).text.length).toBe(PUBLIC_MESSAGE_BYTES);
  expect(line.recording).toMatchObject({ complete: true, originalLength: PUBLIC_MESSAGE_BYTES });
  const revision = line.recording!.revision;
  messages.push("😀ending", "long");
  messages.boundary();
  expect(line.recording).toMatchObject({
    complete: false,
    originalLength: PUBLIC_MESSAGE_BYTES + 8,
    recordedLength: PUBLIC_MESSAGE_BYTES,
    reason: "message-limit",
    state: "finished",
  });
  expect(line.recording!.revision).toBeGreaterThan(revision);
  expect(f.store.read("task", line).text).toBe("a".repeat(PUBLIC_MESSAGE_BYTES));
  expect(line.text.length).toBe(2400);
});

it("shares the task allowance across streams, keeps older text, and gives later messages their preview", () => {
  const f = fixture();
  const full = "a".repeat(PUBLIC_MESSAGE_BYTES);
  for (let index = 0; index < PUBLIC_TASK_BYTES / PUBLIC_MESSAGE_BYTES; index++) {
    const stream = f.stream();
    stream.push(full);
    stream.boundary();
  }
  const short = f.stream();
  short.push("The checks passed.");
  short.boundary();
  const shortLine = f.lines.at(-1)!;
  expect(shortLine.recording).toMatchObject({
    complete: true,
    recordedLength: 18,
    originalLength: 18,
    state: "finished",
  });
  expect(shortLine.recording!.reason).toBeUndefined();
  expect(f.store.read("task", shortLine).text).toBe("The checks passed.");
  const growing = f.stream();
  growing.push("First paragraph.", "growing");
  growing.flush();
  const growingLine = f.lines.at(-1)!;
  expect(growingLine.recording!.complete).toBe(true);
  growing.push("Longer ending. ".repeat(500), "growing");
  growing.boundary();
  expect(growingLine.recording).toMatchObject({
    complete: false,
    reason: "task-limit",
    recordedLength: growingLine.text.length,
  });
  expect(f.store.read("task", growingLine).text).toBe(growingLine.text);
  expect(growing.bufferedBytes).toBe(0);
  const messages = f.stream();
  messages.push("Later public update. ".repeat(300));
  messages.boundary();
  const last = f.lines.at(-1)!;
  expect(last.recording).toMatchObject({ complete: false, reason: "task-limit", recordedLength: last.text.length });
  expect(f.store.read("task", last).text).toBe(last.text);
  expect(f.store.read("task", f.lines[0]!).text).toBe(full);
  expect(f.db.query<{ bytes: number }, []>("SELECT sum(bytes) AS bytes FROM public_messages").get()!.bytes).toBe(
    PUBLIC_TASK_BYTES,
  );
  const other = f.stream("other");
  other.push("A different task.");
  other.boundary();
  expect(f.lines.at(-1)!.recording!.complete).toBe(true);
});

it("keeps recoverable text and an explicit notice after a write failure, without replaying discarded deltas", () => {
  const f = fixture();
  const messages = f.stream();
  messages.push("First saved paragraph. ".repeat(200), "long");
  messages.flush();
  const line = f.lines[0]!;
  const saved = f.store.read("task", line).text;
  f.db.run(
    "CREATE TRIGGER fail_public_write BEFORE INSERT ON public_message_chunks BEGIN SELECT RAISE(FAIL,'disk unavailable'); END",
  );
  messages.push("Unsaved ending. ".repeat(500), "long");
  messages.flush();
  expect(line.recording).toMatchObject({ reason: "storage", complete: false, recordedLength: saved.length });
  f.db.run("DROP TRIGGER fail_public_write");
  messages.push("Still counted.", "long");
  messages.boundary();
  expect(f.store.read("task", line).text).toBe(saved);
  expect(line.recording!.originalLength).toBeGreaterThan(saved.length);
  expect(
    JSON.parse(f.db.query<{ recording: string }, []>("SELECT recording FROM public_messages").get()!.recording).reason,
  ).toBe("storage");
});

it("removes bodies with trimmed conversations and owning records, retaining them when moved into History", () => {
  const f = fixture();
  const messages = f.stream();
  messages.push("Saved public text.");
  messages.boundary();
  const line = f.lines[0]!;
  f.db.query("INSERT INTO active_tasks VALUES(?,?)").run("task", JSON.stringify({ session: [line] }));
  f.db.query("INSERT INTO task_history VALUES(?,?)").run("task", JSON.stringify({ session: [line] }));
  f.db.run("DELETE FROM active_tasks");
  expect(f.store.read("task", line).text).toBe("Saved public text.");
  f.db.query("UPDATE task_history SET body=?").run(JSON.stringify({ session: [] }));
  expect(f.db.query("SELECT * FROM public_messages").all()).toHaveLength(0);
  const other = f.stream("other");
  other.push("Retained until removal.");
  other.boundary();
  f.db.query("INSERT INTO task_history VALUES(?,?)").run("other", JSON.stringify({ session: [f.lines[1]] }));
  f.db.run("DELETE FROM task_history");
  expect(f.db.query("SELECT * FROM public_message_chunks").all()).toHaveLength(0);
});

it("labels recognizable older shortening, while treating other ellipses and completeness as unknown", () => {
  const old = previewRecord({ from: "agent", text: `${"a".repeat(2400)}…` });
  expect(old.text).toHaveLength(2400);
  expect(old.recording).toMatchObject({ complete: false, originalLength: null, reason: "legacy-truncated" });
  expect(previewRecord({ from: "agent", text: `${"a".repeat(2399)}\uD83D…` }).text).toHaveLength(2399);
  for (const text of ["An ordinary message…", "a".repeat(2400), "Short public text."]) {
    expect(previewRecord({ from: "agent", text }).recording).toMatchObject({
      complete: null,
      originalLength: null,
      reason: "legacy-unknown",
    });
  }
});

it("does not join text across an unavailable stored chunk or describe that ending as complete", () => {
  const f = fixture();
  const stream = f.stream();
  stream.push("A public paragraph. ".repeat(2000));
  stream.boundary();
  const line = f.lines[0]!;
  const positions = f.db
    .query<{ position: number }, []>("SELECT position FROM public_message_chunks ORDER BY position")
    .all();
  f.db.query("DELETE FROM public_message_chunks WHERE position=?").run(positions[1]!.position);
  const record = f.store.read("task", line);
  expect(record.text.length).toBe(positions[1]!.position);
  expect(record.recording).toMatchObject({ complete: false, reason: "storage", recordedLength: record.text.length });
});
