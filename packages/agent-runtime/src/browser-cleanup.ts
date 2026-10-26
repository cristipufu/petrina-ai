import type { ObservedProcess, ProcessState } from "@petrina/platform/process-snapshots";
import type { ProcessFolderSnapshot } from "@petrina/platform/process-directory-snapshots";

/** Scoped native observations and signals; the runtime adapter establishes their ownership. */
export interface BrowserReaperEffects {
  readonly observer: number;
  readonly groups: boolean;
  readFolder(directory: string): Promise<ProcessFolderSnapshot | undefined>;
  exists(pid: number): boolean;
  forceKill(pids: readonly number[]): void;
}
export interface BrowserCleanupClock { now(): number; pause(ms: number): Promise<void> }

/** The first words of a failed cleanup attempt's private note: one line in the task's log, engine.log or a test's output. */
export const CLEANUP_NOTE = "Browser cleanup incomplete:";
export const AGENT_CLEANUP_NOTE = "Agent cleanup incomplete:";
const NOTE_BYTES = 4096, NOTE_PROCESSES = 16;

/**
 * One bounded line of private evidence: fixed words, counts and process numbers, never command text, paths,
 * page addresses or browser contents. At most 16 processes, those still present first, with total and omitted counts.
 */
export function cleanupNote(heading: string, facts: readonly (readonly [string, string | number])[], processes: readonly ObservedProcess[]): string {
  const word = (value: string | number) => String(value).replace(/[^A-Za-z0-9:+,-]/g, "_") || "_";
  const order: readonly ProcessState[] = ["running", "finished", "unknown", "absent"];
  const sorted = [...processes].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.pid - b.pid);
  const head = `${heading} ${facts.map(([name, value]) => `${word(name)}=${word(value)}`).join(" ")}`;
  for (let shown = Math.min(sorted.length, NOTE_PROCESSES); ; shown--) {
    const entries = sorted.slice(0, shown).map(({ pid, state, sources }) => `${pid}:${state}:${sources.map(word).join("+")}`);
    const line = `${head} processes=${sorted.length} shown=${shown} omitted=${sorted.length - shown}${shown ? ` owned=${entries.join(",")}` : ""}`;
    if (Buffer.byteLength(line) <= NOTE_BYTES || !shown) return line.slice(0, NOTE_BYTES);
  }
}

/** Why an attempt could not confirm that its browser stopped. */
export type BrowserCleanupReason = "still-running" | "finished-unreleased" | "state-unknown" | "list-unreadable" | "still-listed";

/** Cleanup could not confirm that every browser process stopped. Its note is private evidence for a log, never for the app. */
export class StopUnconfirmed extends Error {
  declare readonly reasons: readonly BrowserCleanupReason[];
  declare readonly note: string;
  constructor(reasons: readonly BrowserCleanupReason[], note: string) {
    super("The headless browser did not stop.");
    // Off the error's listed properties: the note reaches a log once, as its own line, not inside a printed error.
    Object.defineProperties(this, { reasons: { value: reasons }, note: { value: note } });
  }
}

/**
 * What one stop attempt has learned. Every process it finds stays a target until the attempt ends; a later
 * attempt or startup recovery finds ownership afresh through the session folder, never from these numbers.
 */
export class BrowserCleanupAttempt {
  private readonly started: number;
  constructor(private readonly effects: BrowserReaperEffects, private readonly clock: BrowserCleanupClock) { this.started = clock.now(); }
  private readonly owners = new Map<number, Set<string>>();
  private readonly lists = { early: "not-taken", tree: "not-taken" };
  private readonly folders: string[] = [];
  /** The latest folder scan's complete list when it was readable: the states the attempt is judged by. */
  private latest?: ReadonlyMap<number, ProcessState>;
  /** The latest readable folder scan showed nothing of this session still running. */
  clear = false;
  stage = "startup-recovery";
  helper = "not-tracked";

  /** A helper's own process list only adds stopping targets: an empty one says nothing about the folder. */
  listed(source: "early" | "tree", pids: readonly number[] | undefined): void {
    this.lists[source] = pids === undefined ? "unavailable" : String(pids.length);
    this.own(pids ?? [], source);
  }

  targets(): number[] {
    return [...this.owners.keys()];
  }

  /** Processes whose command still names the session folder, or undefined when the list cannot be read. */
  async scan(directory: string): Promise<readonly number[] | undefined> {
    const found = await this.effects.readFolder(directory);
    this.folders.push(found ? String(found.pids.length) : "unavailable");
    this.latest = found ? new Map(found.states) : undefined;
    if (!found) return undefined;
    this.own(found.pids, "folder");
    // A later scan that still finds a process outweighs an earlier clear one, even once that process is stopped.
    this.clear = !found.pids.some(pid => this.effects.exists(pid));
    return found.pids;
  }

  /** The failure when completion is not confirmed: a tracked process remains, or the latest readable scan did not show the folder clear. */
  judge(confirmed: boolean): StopUnconfirmed | undefined {
    const processes = this.targets().map((pid) => ({ pid, state: this.state(pid), sources: [...this.owners.get(pid)!] }));
    const reasons: BrowserCleanupReason[] = [];
    if (processes.some(({ state }) => state === "running")) reasons.push("still-running");
    if (processes.some(({ state }) => state === "finished")) reasons.push("finished-unreleased");
    if (processes.some(({ state }) => state === "unknown")) reasons.push("state-unknown");
    if (!confirmed && this.folders.includes("unavailable")) reasons.push("list-unreadable");
    else if (!confirmed && !reasons.length) reasons.push("still-listed");
    if (!reasons.length) return undefined;
    const facts: [string, string | number][] = [["stage", this.stage], ["elapsed", `${this.clock.now() - this.started}ms`], ["helper", this.helper], ["early", this.lists.early], ["tree", this.lists.tree]];
    this.folders.forEach((scan, index) => facts.push([`folder${index + 1}`, scan]));
    facts.push(["confirmed", confirmed ? "yes" : "no"], ["reasons", reasons.join(",")]);
    return new StopUnconfirmed(reasons, cleanupNote(CLEANUP_NOTE, facts, processes));
  }

  private own(pids: readonly number[], source: string): void {
    for (const pid of pids) {
      if (pid === this.effects.observer) continue;
      const sources = this.owners.get(pid) ?? new Set<string>();
      this.owners.set(pid, sources.add(source));
    }
  }

  /** A process that still exists but is missing from the latest complete list cannot be told apart from a newer one. */
  private state(pid: number): ProcessState {
    if (!this.effects.exists(pid)) return "absent";
    const state = this.latest === undefined ? "unknown" : this.latest.get(pid) ?? "absent";
    return state === "absent" ? "unknown" : state;
  }
}

/**
 * Kill any browser still using this session's folder, then wait until it is actually gone. Success needs the
 * latest readable folder scan in this attempt to show nothing of the session left, and every process the
 * attempt found gone; unknown ownership is never success. Windows keeps its earlier recovery rule.
 */
export async function reapBrowser(directory: string, owned: readonly number[] | undefined, attempt: BrowserCleanupAttempt, effects: BrowserReaperEffects, clock: BrowserCleanupClock): Promise<void> {
  const marked = await attempt.scan(directory);
  // Both ownership sources agree that there is nothing to reap.
  if (owned !== undefined && !owned.length && marked !== undefined && !marked.length) return;
  const still = () => attempt.targets().filter(pid => effects.exists(pid));
  if (still().length) effects.forceKill(still());
  await untilGone(attempt.targets(), 1_000, effects, clock);
  const left = await attempt.scan(directory);
  if (left?.length) effects.forceKill(left.filter(pid => effects.exists(pid)));
  // Commands can stop naming the folder before their processes are released. Every tracked
  // target still gets the existing final wait, even when the folder scan itself is clear.
  if (still().length) await untilGone(attempt.targets(), 1_000, effects, clock);
  const remaining = await attempt.scan(directory);
  // A process can finish between the first wait and the final scan. Judge the final
  // ownership evidence, keeping every earlier target; a provisional timeout is not a sticky failure.
  const failure = attempt.judge(!effects.groups ? owned !== undefined || marked !== undefined || remaining !== undefined : attempt.clear);
  if (failure) throw failure;
}

async function untilGone(pids: readonly number[], ms: number, effects: BrowserReaperEffects, clock: BrowserCleanupClock): Promise<boolean> {
  const targets = [...new Set(pids)];
  for (const end = clock.now() + ms; clock.now() < end; await clock.pause(20)) if (!targets.some(pid => effects.exists(pid))) return true;
  return !targets.some(pid => effects.exists(pid));
}
