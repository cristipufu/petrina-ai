import type { AgentMessage } from "@petrina/orchestrator";

/** Public agent messages, kept separate and published in bounded batches instead of once per token. */
export class AgentMessages {
  private serial = 0;
  private current?: { id: number; source?: string; text: string; published: string; sealed: boolean };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly publish?: (message: AgentMessage) => void) {}

  get streamed(): boolean { return this.publish !== undefined; }

  /** Returns whether this chunk starts a separate message. Tools without ids use tool boundaries. */
  push(text: string, source?: string): boolean {
    if (this.current && source && source !== this.current.source) this.boundary();
    const fresh = !this.current;
    this.current ??= { id: ++this.serial, ...(source ? { source } : {}), text: "", published: "", sealed: false };
    const message = this.current;
    if (message.sealed) return fresh;
    const next = message.text + text;
    const fence = next.indexOf("```");
    // Structured results and code never flash into the app while their closing fence is still arriving.
    const prose = fence >= 0 ? next.slice(0, fence) : next;
    message.text = prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose;
    message.sealed = fence >= 0 || prose.length > 2400;
    if (this.publish && !this.timer) this.timer = setTimeout(() => this.flush(), 1000);
    return fresh;
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const message = this.current;
    const text = message?.text.replace(/`{1,2}$/, "").trim();
    if (!message || !text || text === message.published) return;
    message.published = text;
    this.publish?.({ id: message.id, text });
  }

  /** Explicit message ids stay authoritative even if a tool or reasoning update interleaves their chunks. */
  activity(): void {
    if (this.current?.source) this.flush();
    else this.boundary();
  }

  boundary(): void {
    this.flush();
    this.current = undefined;
  }
}
