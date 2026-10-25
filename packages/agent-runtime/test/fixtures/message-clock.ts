import type { MessageClock } from "../../src/agent-messages.js";

export function messageClockFixture() {
  let now = 0, serial = 0;
  const work = new Map<number, { at: number; run: () => void }>();
  const clock: MessageClock = { after(ms, run) { const id = ++serial; work.set(id, { at: now + ms, run }); return () => { work.delete(id); }; } };
  return {
    clock,
    pending: () => work.size,
    advance(ms: number) { now += ms; for (const [id, due] of [...work]) if (due.at <= now) { work.delete(id); due.run(); } },
  };
}
