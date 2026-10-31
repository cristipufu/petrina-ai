import {
  characterEnd,
  PUBLIC_BATCH_BYTES,
  PUBLIC_MESSAGE_BYTES,
  PUBLIC_PREVIEW_LENGTH,
  utf8ByteLength,
  type AgentMessage,
} from "./public-messages.js";

/** Scheduling belongs to the host; content and grouping need no native timer. */
export interface MessageClock {
  after(ms: number, work: () => void): () => void;
}

export const immediateMessageClock: MessageClock = {
  after: () => () => {},
};

/** Public agent messages, kept separate and published in bounded batches instead of once per token. */
export class AgentMessages {
  private serial = 0;
  private current?: {
    id: number;
    source?: string;
    preview: string;
    previewDone: boolean;
    pending: string;
    pendingBytes: number;
    bytes: number;
    originalLength: number;
    published: number;
    held: string;
    sealed: boolean;
    saving: boolean;
    limited: boolean;
  };
  private cancel?: () => void;

  constructor(
    private readonly clock: MessageClock = immediateMessageClock,
    private readonly publish?: (message: AgentMessage) => unknown,
  ) {}

  get streamed(): boolean {
    return this.publish !== undefined;
  }

  get bufferedBytes(): number {
    return (this.current?.pendingBytes ?? 0) + utf8ByteLength(this.current?.held ?? "");
  }

  /** Explicit ids remain authoritative across interleaved tools and reasoning. */
  push(text: string, source?: string): boolean {
    if (this.current && source && source !== this.current.source) this.boundary();
    const fresh = !this.current;
    this.current ??= {
      id: ++this.serial,
      ...(source ? { source } : {}),
      preview: "",
      previewDone: false,
      pending: "",
      pendingBytes: 0,
      bytes: 0,
      originalLength: 0,
      published: -1,
      held: "",
      sealed: false,
      saving: true,
      limited: false,
    };
    const message = this.current;
    if (message.sealed) return fresh;
    const next = message.held + text;
    message.held = "";
    const fence = next.indexOf("```");
    // Structured results and code never flash into the app while their closing fence is still arriving.
    let prose = fence >= 0 ? next.slice(0, fence) : next;
    message.sealed = fence >= 0;
    if (!message.sealed) {
      // Neither split fences nor half a Unicode character may flash or be written to storage.
      const held = prose.match(/`{1,2}$|[\uD800-\uDBFF]$/)?.[0] ?? "";
      message.held = held;
      prose = prose.slice(0, prose.length - held.length);
    }
    if (!message.originalLength) prose = prose.trimStart();
    // Work in bounded slices even when a tool sends a huge single chunk. There is no whole-message buffer.
    for (let offset = 0; offset < prose.length; ) {
      const end = characterEnd(prose, Math.min(prose.length, offset + 2048));
      const part = prose.slice(offset, end);
      offset = end;
      message.originalLength += part.length;
      if (!message.previewDone) {
        const preview = message.preview + part;
        message.preview = preview.slice(0, characterEnd(preview, PUBLIC_PREVIEW_LENGTH));
        message.previewDone = preview.length >= PUBLIC_PREVIEW_LENGTH;
      }
      if (message.saving) {
        for (const character of part) {
          const bytes = utf8ByteLength(character);
          if (message.bytes + bytes > PUBLIC_MESSAGE_BYTES) {
            message.saving = false;
            message.limited = true;
            break;
          }
          if (message.pendingBytes + bytes > PUBLIC_BATCH_BYTES) this.flush();
          if (!message.saving) break;
          message.pending += character;
          message.pendingBytes += bytes;
          message.bytes += bytes;
        }
      }
    }
    if (this.publish && !this.cancel) this.cancel = this.clock.after(1000, () => this.flush());
    return fresh;
  }

  flush(ended = false, interrupted = false): void {
    this.cancel?.();
    this.cancel = undefined;
    const message = this.current;
    if (
      !message
      || (!message.originalLength && !message.preview)
      || (!ended && !message.pending && message.published === message.originalLength)
    ) {
      return;
    }
    const delta = message.pending;
    message.pending = "";
    message.pendingBytes = 0;
    message.published = message.originalLength;
    const save = this.publish?.({
      id: message.id,
      text: message.preview.trimEnd(),
      delta,
      originalLength: message.originalLength,
      ...(ended ? { ended: true } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      ...(message.limited ? { limited: true } : {}),
    });
    if (save === false) message.saving = false;
  }

  /** Explicit message ids stay authoritative even if a tool or reasoning update interleaves their chunks. */
  activity(): void {
    if (this.current?.source) this.flush();
    else this.boundary();
  }

  boundary(interrupted = false): void {
    this.flush(true, interrupted);
    this.current = undefined;
  }
}

/** Result parsing keeps structured output intact, without an unbounded duplicate of public prose. */
export class TurnText {
  private prose = "";
  private tail = "";
  private held = "";
  private fenced = false;
  private seen = false;
  private readonly result = new StructuredReply();

  push(text: string, boundary = false): void {
    if (boundary && this.seen && !this.fenced) this.push("\n\n");
    this.seen = true;
    this.result.push(text);
    this.tail = (this.tail + text).slice(-1200);
    if (this.fenced) return;
    const next = this.held + text;
    const fence = next.indexOf("```");
    const publicText = fence >= 0 ? next.slice(0, fence) : next.replace(/`{1,2}$/, "");
    this.held = fence >= 0 ? "" : next.slice(publicText.length);
    if (this.prose.length < 1200) this.prose = (this.prose + publicText).slice(0, 1200);
    if (fence >= 0) this.fenced = true;
  }

  get text(): string {
    if (!this.result.text) return this.prose;
    const trimmed = this.prose.replace(/\s+$/, "");
    return trimmed ? `${trimmed}\n\n${this.result.text}` : this.result.text;
  }

  get ending(): string {
    if (!this.result.text) return this.tail;
    const trimmed = this.tail.replace(/\s+$/, "");
    return trimmed ? `${trimmed}\n\n${this.result.text}` : this.result.text;
  }
}

/** Match tagged result blocks anywhere, as parseResult does; unrelated fences never change the search. */
class StructuredReply {
  private mode: "search" | "header" | "result" = "search";
  private held = "";
  private tag = "";
  private body = "";
  text = "";

  push(chunk: string): void {
    let rest = this.held + chunk;
    this.held = "";
    while (rest) {
      if (this.mode === "search") {
        const opening = /```(petrina|json)/.exec(rest);
        if (!opening) {
          // Keep only a possible split marker, never the surrounding ordinary prose or code.
          for (const marker of ["```petrina", "```json"]) {
            for (let size = 1; size < marker.length; size++) {
              if (size > this.held.length && rest.endsWith(marker.slice(0, size))) {
                this.held = rest.slice(-size);
              }
            }
          }
          return;
        }
        this.tag = opening[1]!;
        this.mode = "header";
        rest = rest.slice(opening.index + opening[0].length);
        continue;
      }
      if (this.mode === "header") {
        let index = 0;
        for (; index < rest.length; index++) {
          const character = rest[index]!;
          if (character === "\n") {
            this.mode = "result";
            this.body = "";
            index++;
            break;
          }
          if (!/\s/.test(character)) {
            this.mode = "search";
            break;
          }
        }
        rest = rest.slice(index);
        continue;
      }
      const fence = rest.indexOf("```");
      if (fence < 0) {
        const ticks = rest.match(/`{1,2}$/)?.[0] ?? "";
        this.body += rest.slice(0, rest.length - ticks.length);
        this.held = ticks;
        return;
      }
      this.body += rest.slice(0, fence);
      this.text = "```" + this.tag + "\n" + this.body + "```";
      this.body = "";
      this.mode = "search";
      rest = rest.slice(fence + 3);
    }
  }
}
