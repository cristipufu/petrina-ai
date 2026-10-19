import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, RotateCw } from "lucide-react";
import { agentTools, CHECK_LABELS, CHECK_NAMES, checkOf, fixFor, type CheckId, type Fix, type Platform, type ToolCheck } from "@petrina/core";
import { desktop, mode, sim } from "../engine";
import { safeUrl } from "../lib";

/**
 * The rows first run and the Library show: Claude Code, Codex and the GitHub CLI always, Grok once its
 * check finds it installed, and Git and Node.js only when they are missing.
 */
export function shownChecks(checks: readonly ToolCheck[] | undefined): ToolCheck[] {
  const missing = (["git", "node"] as const).filter((id) => checkOf(checks, id).status === "not-installed");
  const rows: CheckId[] = [...agentTools(checks), "gh", ...missing];
  return rows.map((id) => checkOf(checks, id));
}

/** Check once when this screen opens. Returning focus never launches another probe. */
export function useCheckOnEnter(active: boolean): void {
  const entered = useRef(false);
  useEffect(() => {
    if (!active) { entered.current = false; return; }
    // React's development effect replay is still the same visit to this screen.
    if (entered.current) return;
    entered.current = true;
    void sim.checkTools();
  }, [active]);
}

function statusText(check: ToolCheck): string {
  if (check.status === "unchecked") return "Checking…";
  if (check.id === "gh" && check.status === "ready" && check.account) return `Ready · logged in as ${check.account}`;
  return CHECK_LABELS[check.status];
}

const TONE: Record<ToolCheck["status"], string> = { ready: "ok", "not-installed": "warn", "logged-out": "warn", unknown: "", unchecked: "quiet" };

/** The tools, each with its status and, when it is not Ready, what to do about it. */
export function ToolList({ checks, platform }: { checks: readonly ToolCheck[]; platform: Platform }) {
  return (
    <ul className="tool-list" aria-label="Tools on this machine">
      {checks.map((check) => (
        <ToolRow key={check.id} check={check} platform={platform} />
      ))}
    </ul>
  );
}

function ToolRow({ check, platform }: { check: ToolCheck; platform: Platform }) {
  const fix = fixFor(check.id, check.status, platform);
  const name = CHECK_NAMES[check.id];
  return (
    <li className={`tool-row ${check.status}`} aria-label={`${name}: ${statusText(check)}`}>
      <div className="tool-head">
        <strong>{name}</strong>
        <span className={`label ${TONE[check.status]}`} aria-live="polite">
          {statusText(check)}
          {check.checking && check.status !== "unchecked" && <span className="again"> · checking again…</span>}
        </span>
      </div>
      {fix && <FixSteps fix={fix} detail={check.detail} name={name} />}
    </li>
  );
}

/** One plain sentence, one command with a Copy button, the official guide, and what the tool said behind Details. */
export function FixSteps({ fix, detail, name }: { fix: Fix; detail?: string | undefined; name: string }) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="fix">
      <p>{fix.sentence}</p>
      {fix.command && <CopyCommand command={fix.command} />}
      <div className="fix-links">
        <GuideLink url={fix.guide} name={name} />
        {detail && (
          <button className="linkish" aria-expanded={showDetail} onClick={() => setShowDetail((on) => !on)}>
            {showDetail ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {showDetail && detail && <div className="detail">{detail}</div>}
    </div>
  );
}

/** A command to run in Terminal, with a Copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="command">
      <code>{command}</code>
      <button className="btn small quiet" onClick={() => void copyText(command).then(setCopied)} aria-label={`Copy the command ${command}`}>
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

/** A guide on the web, opened outside the app: by the engine in the desktop app, in a new tab in a browser. */
export function GuideLink({ url, name }: { url: string; name: string }) {
  const safe = safeUrl(url);
  if (!safe) return null;
  return (
    <a
      className="linkish"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!desktop || mode !== "engine") return;
        event.preventDefault();
        sim.openGuide(safe);
      }}
    >
      {name} guide
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}

export function CheckAgain({ checks }: { checks: readonly ToolCheck[] }) {
  const busy = checks.some((check) => check.checking);
  return (
    <button className="btn quiet" onClick={() => sim.checkTools()} disabled={busy}>
      <RotateCw size={16} aria-hidden="true" className={busy ? "spin" : undefined} />
      {busy ? "Checking…" : "Check again"}
    </button>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some windows refuse the clipboard API: the older copy command still works there.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
