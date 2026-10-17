import { CloudOff, User } from "lucide-react";
import { desktop, leaveDemo, mode, openDemo, retryEngine, sim, type EngineStatus, type Unsent } from "../engine";
import { Logo } from "./bits";

/** Browser windows need a terminal; desktop recovery belongs to the app's own engine screen. */
export function EngineRecovery({ status }: { status: EngineStatus }) {
  return (
    <div className="engine-recovery" role="status">
      {status.restarted
        ? <>The Petrina engine restarted. Run <code>bun run open</code> for a fresh window, then close this one.</>
        : <>Can't reach the Petrina engine. In a terminal, run <code>bun run engine</code> and leave it running, then run <code>bun run open</code> in another terminal.</>}
    </div>
  );
}

/**
 * Live, reconnecting or the demo. In the desktop app it also says who started the engine, so quitting
 * holds no surprise. `compact` keeps the dot and moves the words to the tooltip and screen readers.
 */
export function EnginePill({ status, compact = false }: { status: EngineStatus; compact?: boolean }) {
  if (mode === "demo") {
    return desktop ? (
      <button className="engine-status" onClick={leaveDemo} title="Running on a simulated squad. Click to go back to your real products">
        <span className="dot" aria-hidden="true" />
        {compact ? <span className="sr-only">Demo, back to live</span> : "Demo · back to live"}
      </button>
    ) : (
      <span className="engine-status" title="Running on a simulated squad">
        <span className="dot" aria-hidden="true" />
        {compact ? <span className="sr-only">Demo</span> : "Demo"}
      </span>
    );
  }
  const live = status.link === "live";
  const label = live ? "Live" : status.link === "reconnecting" ? "Reconnecting…" : status.link === "starting" ? "Connecting…" : "Not connected";
  const where = live && status.owned !== undefined ? (status.owned ? "started by the app" : "already running") : undefined;
  const title = !live
    ? "Petrina is not connected to its engine right now. What you send waits and goes out when it is back."
    : status.owned === true
      ? "Petrina started this engine. Quitting the app stops it, and its tasks continue next time."
      : status.owned === false
        ? "Petrina is using an engine that was already running. Quitting the app leaves it running."
        : "Connected to the Petrina engine on this machine";
  const text = `${label}${where ? ` · ${where}` : ""}`;
  return (
    <span className="engine-status" title={title}>
      <span className={`dot ${live ? "done" : status.link === "failed" ? "failed" : "needs-you"}`} aria-hidden="true" />
      {compact ? <span className="sr-only">{text}</span> : text}
    </span>
  );
}

/** While the desktop app starts its engine, before anything else shows. */
export function StartingScreen() {
  return (
    <div className="engine-screen" role="status" aria-live="polite">
      <div className="engine-card">
        <span className="mark starting">
          <Logo size={48} />
        </span>
        <h1 className="t">Starting Petrina…</h1>
        <p className="s">Getting the engine ready. The first start can take a few seconds.</p>
      </div>
    </div>
  );
}

/** After three failed attempts in a row. The demo opens only when the coordinator picks it. */
export function CouldNotStart({ problem }: { problem: string | undefined }) {
  return (
    <div className="engine-screen" role="alertdialog" aria-labelledby="engine-failed-title" aria-describedby="engine-failed-text">
      <div className="engine-card">
        <span className="mark avatar tone-slate" aria-hidden="true">
          <CloudOff size={24} />
        </span>
        <h1 className="t" id="engine-failed-title">
          Petrina couldn't start its engine
        </h1>
        <p className="s" id="engine-failed-text">
          It tried three times. Your products and tasks are safe, and come back as soon as the engine starts.
        </p>
        {problem && <p className="problem">{problem}</p>}
        <div className="actions">
          <button className="btn lead" onClick={retryEngine}>
            Try again
          </button>
          <button className="btn" onClick={openDemo}>
            Open the demo
          </button>
        </div>
      </div>
    </div>
  );
}

const WHAT: Record<Unsent["kind"], string> = {
  message: "Your message",
  answer: "Your answer",
  no: "Your “No”",
  changes: "Your change request",
};

/** Where something the coordinator said stands, in a few words. */
function unsentState(entry: Unsent, live: boolean): string {
  return entry.refused ? "Not sent" : live ? "Sending…" : "Waiting to send";
}

/** Why it is held, and what the coordinator can do about it. */
function UnsentFoot({ entry, live }: { entry: Unsent; live: boolean }) {
  if (!entry.refused) return live ? null : <p className="unsent-why">It goes out as soon as Petrina is connected to its engine again.</p>;
  return (
    <>
      <p className="unsent-why">{entry.refused}</p>
      <div className="unsent-actions">
        <button className="btn small" onClick={() => sim.resendUnsent(entry.clientId)}>
          Send it again
        </button>
        <button className="btn small quiet" onClick={() => sim.discardUnsent(entry.clientId)}>
          Discard
        </button>
      </div>
    </>
  );
}

/** Something the coordinator said that the engine has not confirmed saving yet, or refused: in the inbox. */
export function UnsentNote({ entry, live }: { entry: Unsent; live: boolean }) {
  const text = entry.text;
  return (
    <div className={`unsent ${entry.refused ? "refused" : ""}`} role={entry.refused ? "alert" : "status"}>
      <div className="unsent-state">
        {WHAT[entry.kind]} · {unsentState(entry, live)}
      </div>
      {text && <p className="unsent-text">{text}</p>}
      <UnsentFoot entry={entry} live={live} />
    </div>
  );
}

/** The same, in the session's conversation: one of your messages, outlined until the engine has it. */
export function UnsentMessage({ entry, live }: { entry: Unsent; live: boolean }) {
  const text = entry.text;
  return (
    <div className={`msg you queued unsent-msg ${entry.refused ? "refused" : ""}`} role={entry.refused ? "alert" : undefined}>
      <span className="avatar tone-violet" style={{ width: 28, height: 28 }} aria-hidden="true">
        <User size={16} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="name">
          You
          <span className="queued-note">
            {entry.kind === "message" ? unsentState(entry, live) : `${WHAT[entry.kind]} · ${unsentState(entry, live)}`}
          </span>
        </div>
        {text && <div className="bubble">{text}</div>}
        <UnsentFoot entry={entry} live={live} />
      </div>
    </div>
  );
}
