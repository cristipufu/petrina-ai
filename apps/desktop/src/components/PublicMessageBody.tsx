import {
  CONVERSATION_PAGE_LENGTH,
  previewRecord,
  PUBLIC_MESSAGE_BYTES,
  PUBLIC_PREVIEW_LENGTH,
  recordingNotice,
  type RecordedMessage,
  type SessionLine,
} from "@petrina/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sim } from "../engine";
import { MessageBody } from "./MessageBody";

/** Expanded text belongs only to this mounted, visible message; nothing is cached on the task. */
export function PublicMessageBody({
  line,
  taskId,
  finished,
  active = true,
  onRead,
}: {
  line: SessionLine;
  taskId: string;
  finished: boolean;
  active?: boolean;
  onRead?: () => void;
}) {
  const preview = previewRecord(line);
  const [expanded, setExpanded] = useState<RecordedMessage>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const pending = useRef(false);
  const control = useRef<HTMLButtonElement>(null);
  const focusControl = useRef(false);
  useEffect(() => {
    request.current++;
    pending.current = false;
    focusControl.current = false;
    setExpanded(undefined);
    setLoading(false);
    setFailed(false);
    return () => {
      request.current++;
    };
  }, [active, taskId, line.id]);
  useLayoutEffect(() => {
    if (focusControl.current) {
      focusControl.current = false;
      control.current?.focus({ preventScroll: true });
    }
  });

  const load = async (origin: HTMLButtonElement) => {
    if (pending.current) return;
    pending.current = true;
    const own = ++request.current;
    onRead?.();
    setLoading(true);
    setFailed(false);
    try {
      let text = "";
      let offset = 0;
      let recording: RecordedMessage["recording"] | undefined;
      for (;;) {
        const page = await sim.publicMessage(taskId, line.id, offset, CONVERSATION_PAGE_LENGTH);
        if (request.current !== own) return;
        if (!page || page.offset !== offset || (recording && page.recording.revision !== recording.revision)) {
          throw new Error("The saved message changed. Try again.");
        }
        recording = page.recording;
        if (page.text.length > CONVERSATION_PAGE_LENGTH || text.length + page.text.length > PUBLIC_MESSAGE_BYTES) {
          throw new Error("The saved message is unavailable.");
        }
        text += page.text;
        if (page.next === undefined) break;
        if (page.next <= offset) throw new Error("The saved message is unavailable.");
        offset = page.next;
      }
      // The refresh control disappears on success. Move only its still-present keyboard focus.
      focusControl.current = origin !== control.current && document.activeElement === origin;
      setExpanded({ text, recording: recording! });
    } catch {
      if (request.current === own) setFailed(true);
    } finally {
      if (request.current === own) {
        pending.current = false;
        setLoading(false);
      }
    }
  };
  const record = expanded ?? preview;
  const notice = recordingNotice(record.recording);
  const newer = expanded && expanded.recording.revision !== preview.recording.revision;
  const canExpand =
    preview.recording.recordedLength > PUBLIC_PREVIEW_LENGTH && preview.recording.recordedLength > preview.text.length;
  return (
    <>
      <MessageBody text={record.text} taskId={taskId} productId={line.productId} finished={finished} />
      {notice && <p className="message-recording-note">{notice}</p>}
      {(canExpand || expanded || failed || loading) && (
        <div className="message-reading-controls">
          <button
            ref={control}
            className="linkish"
            type="button"
            aria-expanded={Boolean(expanded)}
            aria-disabled={loading}
            onClick={(event) => {
              if (pending.current) return;
              if (expanded) {
                request.current++;
                setExpanded(undefined);
                setFailed(false);
              } else {
                void load(event.currentTarget);
              }
            }}
          >
            {loading ? "Loading message…" : expanded ? "Show less" : failed ? "Try again" : "Read full message"}
          </button>
          {failed && <span role="status">Could not load the saved message. Try again.</span>}
          {newer && (
            <button
              className="linkish"
              type="button"
              aria-disabled={loading}
              onClick={(event) => void load(event.currentTarget)}
            >
              Read updated message
            </button>
          )}
        </div>
      )}
    </>
  );
}
