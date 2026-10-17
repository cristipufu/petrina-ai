import { useRef } from "react";
import { CloudOff, User } from "lucide-react";
import { desktop, leaveDemo, mode, openDemo, retryEngine, sim, useUnsent, type EngineStatus, type Unsent } from "../engine";
import { Logo, useFocusTrap } from "./bits";

/** What a browser tab can do about a connection it cannot repair itself. The same words in both places. */
export function RecoveryLine({ status }: { status: EngineStatus }) {
  return status.restarted ? (
    <>The Petrina engine restarted. Run <code>bun run open</code> for a fresh window, then close this one.</>
  ) : (
    <>Can't reach the Petrina engine. In a terminal, run <code>bun run engine</code> and leave it running, then run <code>bun run open</code> in another terminal.</>
  );
}

/** Browser windows need a terminal; desktop recovery belongs to the app's own engine screen. */
export function EngineRecovery({ status }: { status: EngineStatus }) {
  return (
    <div className="engine-recovery" role="status">
      <RecoveryLine status={status} />
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

/**
 * Until the engine's real state arrives, before anything else shows: the desktop app starting its
 * engine, or a browser tab connecting to one. A browser tab whose saved key the engine refuses
 * stops here and says how to open a fresh window. Starting the engine cannot fix that key, so the
 * tab does not keep saying it is starting.
 */
export function StartingScreen({ status }: { status: EngineStatus }) {
  const refused = !status.desktop && status.restarted === true;
  return (
    <div className="engine-screen" role="status" aria-live="polite">
      <div className="engine-card">
        {refused ? (
          <span className="mark avatar tone-slate" aria-hidden="true">
            <CloudOff size={24} />
          </span>
        ) : (
          <span className="mark starting">
            <Logo size={48} />
          </span>
        )}
        <h1 className="t">{refused ? "Petrina needs a fresh window" : "Starting Petrina…"}</h1>
        <p className="s">
          {refused ? <RecoveryLine status={status} /> : status.desktop ? "Getting the engine ready. The first start can take a few seconds." : "Connecting to Petrina's engine on this machine."}
        </p>
        {!refused && !status.desktop && status.problem && <p className="problem">Still trying: {status.problem} If the engine isn't running, start it with bun run engine.</p>}
      </div>
    </div>
  );
}

/**
 * After three failed attempts in a row. The demo opens only when the coordinator picks it, and what
 * is not sent yet is kept through it, to go out once the window is back on the engine.
 */
export function CouldNotStart({ problem }: { problem: string | undefined }) {
  const waiting = useUnsent().length;
  // It covers the whole window: the keyboard stays on it, never on what is hidden behind it.
  const card = useRef<HTMLDivElement>(null);
  useFocusTrap(card);
  return (
    <div className="engine-screen" role="alertdialog" aria-labelledby="engine-failed-title" aria-describedby="engine-failed-text">
      <div className="engine-card" ref={card} tabIndex={-1}>
        <span className="mark avatar tone-slate" aria-hidden="true">
          <CloudOff size={24} />
        </span>
        <h1 className="t" id="engine-failed-title">
          Petrina couldn't start its engine
        </h1>
        <p className="s" id="engine-failed-text">
          It tried three times. Your products and tasks are safe, and come back as soon as the engine starts.
          {waiting > 0 && ` ${waiting === 1 ? "One thing you said is" : `${waiting} things you said are`} waiting to be sent: ${waiting === 1 ? "it goes" : "they go"} out once the engine is back, even if you open the demo first.`}
        </p>
        {problem && <p className="problem">{problem}</p>}
        <div className="actions">
          <button className="btn lead" onClick={retryEngine} autoFocus>
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
        <button className="btn" onClick={() => sim.resendUnsent(entry.clientId)}>
          Send it again
        </button>
        <button className="btn quiet" onClick={() => sim.discardUnsent(entry.clientId)}>
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
