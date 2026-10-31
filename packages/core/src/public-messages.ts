import type { SessionLine } from "./review-model.js";

export const PUBLIC_PREVIEW_LENGTH = 2400;
export const PUBLIC_MESSAGE_BYTES = 256 * 1024;
export const PUBLIC_TASK_BYTES = 16 * 1024 * 1024;
export const PUBLIC_BATCH_BYTES = 8 * 1024;
export const CONVERSATION_PAGE_LENGTH = 32_000;

export interface PublicRecording {
  recordedLength: number;
  /** UTF-16 characters of eligible public prose observed, including any unavailable ending. */
  originalLength: number | null;
  complete: boolean | null;
  state: "streaming" | "finished" | "interrupted" | "unknown";
  reason?: "message-limit" | "task-limit" | "storage" | "interrupted" | "legacy-truncated" | "legacy-unknown";
  revision: number;
}

export interface RecordedMessage {
  text: string;
  recording: PublicRecording;
}

export interface MessagePage extends RecordedMessage {
  offset: number;
  next?: number;
}

/** Only filtered public prose reaches this callback. Deltas are bounded; previews never contain notices. */
export interface AgentMessage {
  id: number;
  text: string;
  delta?: string;
  originalLength?: number;
  ended?: boolean;
  interrupted?: boolean;
  limited?: boolean;
}

/** Exact UTF-8 byte count without Node or browser buffer globals. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** An offset is always between Unicode characters. Lengths retain the existing UTF-16 convention. */
export function characterEnd(text: string, end: number): number {
  return end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "")
    ? end - 1
    : end;
}

/** Old generated previews have one recognizable shape; other ellipses prove nothing. */
export function previewRecord(line: Pick<SessionLine, "text" | "from" | "recording">): RecordedMessage {
  if (line.recording) return { text: line.text, recording: line.recording };
  const shortened = line.from === "agent" && line.text.length === PUBLIC_PREVIEW_LENGTH + 1 && line.text.endsWith("…");
  // Older slice-based previews could also discard the second half of their last character.
  const text = shortened ? line.text.slice(0, PUBLIC_PREVIEW_LENGTH).replace(/[\uD800-\uDBFF]$/, "") : line.text;
  return {
    text,
    recording: {
      recordedLength: text.length,
      originalLength: line.from === "agent" ? null : text.length,
      complete: line.from === "agent" ? (shortened ? false : null) : true,
      state: "unknown",
      revision: 0,
      ...(line.from === "agent"
        ? { reason: shortened ? ("legacy-truncated" as const) : ("legacy-unknown" as const) }
        : {}),
    },
  };
}

export function recordingNotice(recording: PublicRecording): string | undefined {
  switch (recording.reason) {
    case "message-limit":
      return "The message reached the 256 KiB recording limit. Its ending was not saved.";
    case "task-limit":
      return "This task reached its 16 MiB recording allowance. Additional text was not saved.";
    case "storage":
      return "Some text could not be saved or recovered. Only the available recorded text can be read.";
    case "interrupted":
      return "Recording was interrupted. Only the text saved before the interruption is available.";
    case "legacy-truncated":
      return "This older message's ending was not recorded and cannot be read.";
    case "legacy-unknown":
      return "This older record does not establish whether the message is complete or its original length.";
    default:
      return undefined;
  }
}

export function messagePage(record: RecordedMessage, offset = 0, limit = CONVERSATION_PAGE_LENGTH): MessagePage {
  const start = characterEnd(record.text, Math.max(0, Math.min(offset, record.text.length)));
  let end = characterEnd(
    record.text,
    Math.min(record.text.length, start + Math.max(2, Math.min(limit, CONVERSATION_PAGE_LENGTH))),
  );
  if (end === start && end < record.text.length) end += 2;
  return {
    text: record.text.slice(start, end),
    recording: record.recording,
    offset: start,
    ...(end < record.text.length ? { next: end } : {}),
  };
}
