import { CloudOff } from "lucide-react";
import { desktop, leaveDemo, mode, openDemo, retryEngine, type EngineStatus, type Unsent } from "../engine";
import { Logo } from "./bits";

/** Live, reconnecting or the demo. In the desktop app it also says who started the engine, so quitting holds no surprise. */
export function EnginePill({ status }: { status: EngineStatus }) {
  if (mode === "demo") {
    return desktop ? (
      <button className="engine-pill linkish" onClick={leaveDemo} title="Running on a simulated squad. Click to go back to your real products">
        <span className="dot" />
        Demo · back to live
      </button>
    ) : (
      <span className="engine-pill" title="Running on a simulated squad">
        <span className="dot" />
        Demo
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
  return (
    <span className="engine-pill" title={title}>
      <span className={`dot ${live ? "done" : status.link === "failed" ? "failed" : "needs-you"}`} />
      {label}
      {where && <span className="where">· {where}</span>}
    </span>
  );
}

/** While the desktop app starts its engine, before anything else shows. */
export function StartingScreen() {
  return (
    <div className="engine-screen" role="status" aria-live="polite">
      <div className="engine-card">
        <span className="starting">
          <Logo size={44} />
        </span>
        <div className="t">Starting Petrina…</div>
        <div className="s">Getting the engine ready. The first start can take a few seconds.</div>
      </div>
    </div>
  );
}

/** After three failed attempts in a row. The demo opens only when the coordinator picks it. */
export function CouldNotStart({ problem }: { problem: string | undefined }) {
  return (
    <div className="engine-screen" role="alertdialog" aria-label="Petrina could not start">
      <div className="engine-card">
        <span className="avatar tone-slate" style={{ width: 44, height: 44, borderRadius: 14 }}>
          <CloudOff size={22} />
        </span>
        <div className="t">Petrina couldn't start its engine</div>
        <div className="s">It tried three times. Your products and tasks are safe, and come back as soon as the engine starts.</div>
        {problem && <div className="detail">{problem}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 6 }}>
          <button className="btn primary" onClick={retryEngine}>
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

const UNSENT_LABEL: Record<Unsent["kind"], string> = {
  message: "Unsent message",
  answer: "Unsent answer",
  no: "Unsent “No”",
  changes: "Unsent change request",
};

/** Something the coordinator said that the engine has not confirmed saving yet. */
export function UnsentNote({ entry, live }: { entry: Unsent; live: boolean }) {
  return (
    <span className="q unsent" title={live ? "Sending" : "Petrina is not connected to its engine. This goes out as soon as it is back."}>
      <span>
        {live ? "Sending" : UNSENT_LABEL[entry.kind]}
        {entry.text ? `: ${entry.text}` : ""}
      </span>
    </span>
  );
}
