// When Petrina notifies. Only what is new: items already waiting when the app opens only show in
// the counts, and after a reconnect only what arrived during the gap is new. While Petrina is in
// front, or with notifications off, the in-app message shows instead. Calm pacing: the first
// notification goes out at once, then nothing for ten seconds; what arrived meanwhile goes out
// when the pause ends, alone or as one summary. Nothing already shown is ever taken back.

import { notifiableInboxItem, type InboxItem, type State } from "@petrina/core";
import { noticeFor, summaryOf, type Notice } from "./words";

/** At most one notification this often. */
export const PAUSE_MS = 10_000;

/** Run `run` after `ms`; the result cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

/** Which inbox items are new since the last look. Petrina never notifies the same item twice. */
export class InboxWatch {
  private readonly known = new Set<string>();
  private ready = false;

  /**
   * `synced`: the inbox is the squad's own, not the empty one the window starts with. The first
   * synced look learns what is already waiting; after that, anything not seen before is new.
   */
  update(inbox: readonly InboxItem[], synced: boolean): InboxItem[] {
    if (!synced) return [];
    // "You're driving" follows the coordinator's own take-over: it needs no notification. A screen request is
    // quiet: it waits in the inbox with no notification or in-app message.
    const fresh = this.ready ? inbox.filter((item) => !this.known.has(item.id) && notifiableInboxItem(item)) : [];
    for (const item of inbox) this.known.add(item.id);
    this.ready = true;
    return fresh;
  }
}

/**
 * At most one notification per pause. The first item goes out at once and starts the pause;
 * items that arrive during it are held, and go out when it ends: one alone, two or more as one
 * summary. Each notification sent starts a new pause.
 */
export class Pacer {
  private held: string[] = [];
  private cancel: (() => void) | undefined;

  constructor(
    private readonly send: (ids: readonly string[]) => void,
    private readonly schedule: Schedule,
    private readonly pauseMs = PAUSE_MS,
  ) {}

  add(id: string): void {
    if (this.cancel) {
      if (!this.held.includes(id)) this.held.push(id);
      return;
    }
    this.send([id]);
    this.pause();
  }

  /** Held items that were handled meanwhile are dropped. */
  keep(waiting: ReadonlySet<string>): void {
    this.held = this.held.filter((id) => waiting.has(id));
  }

  /** Petrina came to the front, or notifications were switched off: what was held is dropped. */
  clear(): void {
    this.held = [];
  }

  get holding(): readonly string[] {
    return this.held;
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.held = [];
  }

  private pause(): void {
    this.cancel = this.schedule(() => {
      this.cancel = undefined;
      const batch = this.held;
      this.held = [];
      if (batch.length === 0) return;
      this.send(batch);
      this.pause();
    }, this.pauseMs);
  }
}

/** What the notifier needs from the window it runs in. */
export interface NotifierHost {
  /** Petrina is in front: visible and focused. */
  inFront(): boolean;
  /** System or browser notifications are switched on and possible here (never in the demo). */
  canNotify(): boolean;
  /** Show a system or browser notification. False when it was not shown because Petrina is in front. */
  show(notice: Notice): Promise<boolean> | boolean;
  /** The small in-app message. */
  toast(notice: Notice): void;
  /** The items still waiting, after every change, so a browser can close what was handled. */
  waiting?(ids: ReadonlySet<string>): void;
  schedule: Schedule;
}

export class Notifier {
  private readonly watch = new InboxWatch();
  private readonly pacer: Pacer;
  private state: State | undefined;
  /** System or browser notifications sent this run (not counting the test). */
  sent = 0;

  constructor(private readonly host: NotifierHost) {
    this.pacer = new Pacer((ids) => this.send(ids), host.schedule);
  }

  /** A new state from the squad. `synced`: it is the squad's own, not the empty start. */
  update(state: State, synced: boolean): void {
    this.state = state;
    const waiting = new Set(state.inbox.map((item) => item.id));
    this.pacer.keep(waiting);
    this.host.waiting?.(waiting);
    for (const item of this.watch.update(state.inbox, synced)) {
      if (this.host.canNotify() && !this.host.inFront()) this.pacer.add(item.id);
      else this.host.toast(noticeFor(item, state));
    }
  }

  /** Petrina came to the front: held items are in plain view now. */
  cameToFront(): void {
    this.pacer.clear();
  }

  /** Notifications were switched off: nothing held goes out. */
  switchedOff(): void {
    this.pacer.clear();
  }

  dispose(): void {
    this.pacer.dispose();
  }

  private send(ids: readonly string[]): void {
    const state = this.state;
    if (!state || !this.host.canNotify()) return;
    const items = ids.map((id) => state.inbox.find((item) => item.id === id)).filter((item): item is InboxItem => item !== undefined);
    if (items.length === 0) return;
    const notice = items.length === 1 ? noticeFor(items[0]!, state) : summaryOf(items, state);
    // Petrina came to the front just now (the shell checks too), or the system refused: the
    // in-app message shows instead, so nothing is missed.
    const instead = () => {
      for (const item of items) this.host.toast(noticeFor(item, state));
    };
    let shown: Promise<boolean> | boolean;
    try {
      shown = this.host.show(notice);
    } catch {
      return instead();
    }
    void Promise.resolve(shown).then(
      (yes) => {
        if (yes) this.sent += 1;
        else instead();
      },
      instead,
    );
  }
}
