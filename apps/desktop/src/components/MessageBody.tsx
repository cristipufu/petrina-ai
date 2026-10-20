import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Expand, Image as ImageIcon, X } from "lucide-react";
import { failureText, sim } from "../engine";
import { useFocusTrap } from "./bits";

type MessagePart = { kind: "text"; text: string } | { kind: "image"; label: string; path: string };

/** Recognize local screenshot links only; everything else remains harmless plain text. */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const links = /!?\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
  let end = 0;
  for (const match of text.matchAll(links)) {
    let path = match[2]!.replace(/^<|>$/g, "");
    try { path = decodeURIComponent(path); } catch { /* A literal percent is allowed in a filename. */ }
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path) || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^(?:file:|[a-z]:[\\/])/i.test(path)) || path.startsWith("//")) continue;
    if (match.index > end) parts.push({ kind: "text", text: text.slice(end, match.index) });
    parts.push({ kind: "image", label: match[1]?.trim() || "Screenshot", path });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ kind: "text", text: text.slice(end) });
  return parts;
}

/** Screenshot bytes live only in a visible preview, never in saved task or window state. */
export const MessageBody = memo(function MessageBody({ text, taskId, productId, finished = false }: { text: string; taskId: string; productId?: string; finished?: boolean }) {
  const parts = useMemo(() => messageParts(text), [text]);
  const content: ReactNode[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.kind === "text") { content.push(<span key={index}>{part.text}</span>); continue; }
    const images = [part];
    const first = index;
    while (parts[index + 1]?.kind === "text" && /^[\s·|,]*$/.test((parts[index + 1] as { text: string }).text) && parts[index + 2]?.kind === "image") {
      images.push(parts[index + 2] as typeof part);
      index += 2;
    }
    content.push(<span className="message-images" key={first}>{images.map((image, item) => <ImagePreview key={`${item}:${image.path}`} taskId={taskId} productId={productId} path={image.path} label={image.label} finished={finished} />)}</span>);
  }
  return <>{content}</>;
});

/** Both saved report pictures and links share the same bounded, visible-only image lifetime. */
export function ImagePreview({ taskId, productId, path, imageId, label, finished }: { taskId: string; productId?: string; path?: string; imageId?: string; label: string; finished: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element || finished) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    // Fast scrolling can queue both entering and leaving this one observed image.
    const observer = new IntersectionObserver((entries) => setVisible(Boolean(entries.at(-1)?.isIntersecting)), { rootMargin: "100px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [finished]);

  useEffect(() => {
    if (finished || (!visible && !expanded)) { setUrl(undefined); return; }
    let disposed = false;
    let objectUrl: string | undefined;
    setError(undefined);
    void Promise.resolve().then(async () => {
      if (imageId) return sim.image(taskId, imageId);
      const { mime, data } = await (productId ? sim.previewImage(taskId, path!, productId) : sim.previewImage(taskId, path!));
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return new Blob([bytes], { type: mime });
    }).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      const olderEngine = (message.includes('"invalid_value"') && message.includes('"name"')) || /(?:unknown|unsupported|unrecognized).*previewImage/i.test(message);
      if (!disposed) setError(olderEngine ? "Preview will be available after the engine is updated." : failureText(reason));
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [taskId, productId, path, imageId, visible || expanded, finished, attempt]);

  // A loading thumbnail stays focusable when closing releases its offscreen image.
  return <span ref={box} className="message-image">
    {finished ? <span className="message-image-unavailable"><ImageIcon size={16} aria-hidden="true" /><strong>{label}</strong><span>Preview unavailable after the task finishes.</span></span>
      : error ? <span className="message-image-unavailable"><ImageIcon size={16} aria-hidden="true" /><strong>{label}</strong><span role="status">{error}</span><button className="btn ghost small" onClick={() => setAttempt((value) => value + 1)}>Try again</button></span>
      : <button className="message-image-open" aria-disabled={!url} onClick={() => { if (url) setExpanded(true); }} aria-label={`Enlarge ${label} screenshot`}>
          {url ? <img src={url} alt={`${label} screenshot`} decoding="async" onError={() => setError("This screenshot could not be displayed.")} /> : <span className="message-image-loading"><ImageIcon size={22} aria-hidden="true" />{visible ? "Loading screenshot…" : "Screenshot"}</span>}
          <span className="message-image-caption"><strong>{label}</strong><Expand size={14} aria-hidden="true" /></span>
        </button>}
    {expanded && url && !finished && createPortal(<ImageLightbox url={url} label={label} onClose={() => setExpanded(false)} />, document.body)}
  </span>;
}

function ImageLightbox({ url, label, onClose }: { url: string; label: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useId();
  useFocusTrap(panel, onClose);
  return <div className="message-image-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="message-image-dialog" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
      <div className="message-image-dialog-head"><strong id={title}>{label}</strong><button className="btn ghost icon" aria-label="Close screenshot" onClick={onClose}><X size={20} /></button></div>
      <div className="message-image-full"><img src={url} alt={`${label} screenshot`} /></div>
    </div>
  </div>;
}
