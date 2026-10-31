// Task-owned public recordings. Synchronous bounded transactions have no pending write queue.
import type { Database } from "bun:sqlite";
import {
  previewRecord,
  PUBLIC_MESSAGE_BYTES,
  PUBLIC_TASK_BYTES,
  type AgentMessage,
  type PublicRecording,
  type RecordedMessage,
  type SessionLine,
  type State,
  type Task,
} from "@petrina/core";

type Row = { line: string; bytes: number; length: number; recording: string };
type StoredRecording = PublicRecording & { blocked?: PublicRecording["reason"] };

export class PublicText {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS public_messages (
      task_id TEXT NOT NULL, id TEXT NOT NULL, line TEXT NOT NULL, bytes INTEGER NOT NULL,
      length INTEGER NOT NULL, recording TEXT NOT NULL, PRIMARY KEY(task_id,id))`);
    db.run(`CREATE TABLE IF NOT EXISTS public_message_chunks (
      task_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY(task_id,id,position))`);
    // Deletion follows the owning task, including ordinary product/history removal.
    for (const table of ["active_tasks", "task_history"]) {
      const other = table === "active_tasks" ? "task_history" : "active_tasks";
      db.run(`CREATE TRIGGER IF NOT EXISTS public_text_${table}_removed AFTER DELETE ON ${table}
        WHEN NOT EXISTS (SELECT 1 FROM ${other} WHERE id=OLD.id) BEGIN
        DELETE FROM public_message_chunks WHERE task_id=OLD.id;
        DELETE FROM public_messages WHERE task_id=OLD.id;
      END`);
      db.run(`CREATE TRIGGER IF NOT EXISTS public_text_${table}_trimmed AFTER UPDATE OF body ON ${table} BEGIN
        DELETE FROM public_message_chunks WHERE task_id=NEW.id AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(NEW.body,'$.session'));
        DELETE FROM public_messages WHERE task_id=NEW.id AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(NEW.body,'$.session'));
      END`);
    }
  }

  /** A failed write never claims its unsaved delta is recoverable. The preview is still available. */
  append(taskId: string, line: SessionLine, message: AgentMessage): { recording: PublicRecording; accepting: boolean } {
    const previous = line.recording;
    try {
      return this.db
        .transaction(() => {
          const row = this.row(taskId, line.id);
          const prior: StoredRecording | undefined = row ? JSON.parse(row.recording) : previous;
          let length = row?.length ?? 0;
          let bytes = row?.bytes ?? 0;
          const used = this.db
            .query<{ bytes: number }, [string]>("SELECT coalesce(sum(bytes),0) AS bytes FROM public_messages WHERE task_id=?")
            .get(taskId)!.bytes;
          let reason = prior?.blocked ?? previous?.reason ?? prior?.reason;
          let delta = "";
          if (!reason) {
            let allowance = Math.min(PUBLIC_MESSAGE_BYTES - bytes, PUBLIC_TASK_BYTES - used);
            const incoming = message.delta ?? message.text;
            if (Buffer.byteLength(incoming) <= allowance) delta = incoming;
            else {
              for (const character of incoming) {
                const size = Buffer.byteLength(character);
                if (size > allowance) {
                  reason =
                    bytes + Buffer.byteLength(delta) + size > PUBLIC_MESSAGE_BYTES ? "message-limit" : "task-limit";
                  break;
                }
                delta += character;
                allowance -= size;
              }
            }
          }
          if (delta) {
            this.db
              .query("INSERT INTO public_message_chunks(task_id,id,position,text) VALUES(?,?,?,?)")
              .run(taskId, line.id, length, delta);
            length += delta.length;
            bytes += Buffer.byteLength(delta);
          }
          const recordedLength = Math.max(length, line.text.length);
          const originalLength = message.originalLength ?? message.text.length;
          if (!reason && message.limited) reason = "message-limit";
          if (!reason && message.ended && originalLength > recordedLength) reason = "storage";
          if (message.interrupted && !reason) reason = "interrupted";
          const accepting = !reason;
          const blocked = reason;
          // A full preview can retain a later short message even when no separate body allowance remains.
          if ((reason === "task-limit" || reason === "message-limit") && recordedLength === originalLength) {
            reason = message.interrupted ? "interrupted" : undefined;
          }
          const recording: PublicRecording = {
            recordedLength,
            originalLength,
            complete: reason || message.interrupted ? false : originalLength === recordedLength,
            state: message.interrupted ? "interrupted" : message.ended ? "finished" : "streaming",
            revision: (previous?.revision ?? prior?.revision ?? 0) + 1,
            ...(reason ? { reason } : {}),
          };
          this.db
            .query(`INSERT INTO public_messages(task_id,id,line,bytes,length,recording) VALUES(?,?,?,?,?,?)
              ON CONFLICT(task_id,id) DO UPDATE SET line=excluded.line,bytes=excluded.bytes,length=excluded.length,recording=excluded.recording`)
            .run(
              taskId,
              line.id,
              JSON.stringify({ ...line, recording }),
              bytes,
              length,
              JSON.stringify({ ...recording, ...(blocked ? { blocked } : {}) }),
            );
          return { recording, accepting };
        })
        .immediate();
    } catch {
      return {
        accepting: false,
        recording: {
          recordedLength: Math.max(previous?.recordedLength ?? 0, line.text.length),
          originalLength: message.originalLength ?? message.text.length,
          complete: false,
          state: message.interrupted ? "interrupted" : message.ended ? "finished" : "streaming",
          reason: "storage",
          revision: (previous?.revision ?? 0) + 1,
        },
      };
    }
  }

  private row(taskId: string, id: string): Row | null {
    return this.db
      .query<Row, [string, string]>("SELECT line,bytes,length,recording FROM public_messages WHERE task_id=? AND id=?")
      .get(taskId, id);
  }

  read(taskId: string, line: SessionLine): RecordedMessage {
    if (!line.recording) return previewRecord(line);
    try {
      const row = this.row(taskId, line.id);
      const chunks = row
        ? this.db
            .query<{ position: number; text: string }, [string, string]>(
              "SELECT position,text FROM public_message_chunks WHERE task_id=? AND id=? ORDER BY position",
            )
            .all(taskId, line.id)
        : [];
      let body = "";
      for (const chunk of chunks) {
        if (chunk.position !== body.length) break;
        body += chunk.text;
      }
      const text = body.length >= line.text.length ? body : line.text;
      const recording = line.recording;
      return {
        text,
        recording:
          text.length === recording.recordedLength
            ? recording
            : { ...recording, recordedLength: text.length, complete: false, reason: "storage" },
      };
    } catch {
      return {
        text: line.text,
        recording: { ...line.recording, recordedLength: line.text.length, complete: false, reason: "storage" },
      };
    }
  }

  /** Batches can reach disk before the compact task save. Recover their identities and previews once. */
  recover(state: State): void {
    for (const task of state.tasks) {
      const lines = new Map(task.session.map((line) => [line.id, line]));
      const rows = this.db
        .query<{ id: string; line: string }, [string]>("SELECT id,line FROM public_messages WHERE task_id=? ORDER BY rowid")
        .all(task.id);
      for (const row of rows) {
        const saved = JSON.parse(row.line) as SessionLine;
        const current = lines.get(row.id);
        // Equal revisions can have newer engine-owned attachments in the compact task save.
        const line =
          current && (current.recording?.revision ?? -1) >= (saved.recording?.revision ?? -1)
            ? current
            : { ...current, ...saved, ...(current?.images ? { images: current.images } : {}) };
        if (line.recording?.state === "streaming") {
          line.recording = {
            ...line.recording,
            state: "interrupted",
            complete: false,
            reason: line.recording.reason ?? "interrupted",
            revision: line.recording.revision + 1,
          };
        }
        lines.set(row.id, line);
        state.seq = Math.max(state.seq, Number(row.id.match(/-(\d+)$/)?.[1] ?? 0));
      }
      (task as { session: readonly SessionLine[] }).session = [...lines.values()].sort((a, b) => a.at - b.at);
    }
  }

  remove(taskId: string, messageId: string): void {
    this.db.query("DELETE FROM public_message_chunks WHERE task_id=? AND id=?").run(taskId, messageId);
    this.db.query("DELETE FROM public_messages WHERE task_id=? AND id=?").run(taskId, messageId);
  }

  /** Pruning and shared-product removal follow the same saved conversation membership. */
  retain(task: Task): void {
    const ids = new Set(task.session.map((line) => line.id));
    for (const row of this.db.query<{ id: string }, [string]>("SELECT id FROM public_messages WHERE task_id=?").all(task.id)) {
      if (!ids.has(row.id)) this.remove(task.id, row.id);
    }
  }
}
