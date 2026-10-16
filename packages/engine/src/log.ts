// Where the engine's output goes. Started by the desktop app, its stdout is the private line to
// the shell, so everything it prints (crash messages included) goes to engine.log in the Petrina
// folder instead. Only the engine that holds the folder opens the log, and it starts it fresh.
// Writes are synchronous: nothing waits on a reader, and a crash message is on disk before exit.

import { closeSync, openSync, writeSync } from "node:fs";
import { format } from "node:util";

const EARLY_LIMIT = 1 << 20;
const decoder = new TextDecoder();

export class OutputLog {
  private fd: number | undefined;
  private early: string[] = [];
  private earlySize = 0;
  private discarded = false;

  /** `tee`: still print to the terminal as well (an engine started by hand). */
  constructor(private readonly tee = false) {}

  /** Send console output and the process streams here. Until `open`, it waits in memory. */
  capture(): void {
    const original = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      console[level] = (...args: unknown[]) => {
        const text = `${format(...args)}\n`;
        this.write(text);
        if (this.tee) (level === "log" || level === "info" ? original.out : original.err)(text);
      };
    }
    const patch = (stream: NodeJS.WriteStream, through: (chunk: string) => boolean) => {
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? decoder.decode(chunk) : String(chunk);
        this.write(text);
        if (this.tee) through(text);
        const callback = rest.find((entry) => typeof entry === "function") as (() => void) | undefined;
        callback?.();
        return true;
      }) as NodeJS.WriteStream["write"];
    };
    patch(process.stdout, original.out);
    patch(process.stderr, original.err);
  }

  /** Start the file fresh and write what was held so far. */
  open(path: string): void {
    this.fd = openSync(path, "w", 0o600);
    for (const text of this.early) this.write(text);
    this.early = [];
  }

  /** An engine that steps aside never touches the log. */
  discard(): void {
    this.discarded = true;
    this.early = [];
  }

  write(text: string): void {
    if (this.fd !== undefined) {
      try {
        writeSync(this.fd, text);
      } catch {
        // A full disk must not take the engine down.
      }
      return;
    }
    if (this.discarded || this.earlySize > EARLY_LIMIT) return;
    this.early.push(text);
    this.earlySize += text.length;
  }

  close(): void {
    this.discarded = true;
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }
}
