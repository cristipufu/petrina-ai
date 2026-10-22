// The task sheet's Design tab: the brief, the architects' objections and how each was settled.

import { useState } from "react";
import type { Objection, Task } from "@petrina/core";
import { profileText, type Lookup } from "../../lib";
import { openFirst } from "./order";
import { AcceptanceChecklist } from "./AcceptanceChecklist";

export function ObjectionItem({ objection, find }: { objection: Objection; find: Lookup }) {
  const status = objection.status === "open" ? "Open" : objection.status === "accepted" ? "Accepted" : objection.status === "noted" ? "Follow-up" : "Rejected";
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${objection.status === "open" ? (objection.blocking ? "bad" : "warn") : objection.status === "accepted" ? "ok" : ""}`}>{status}</span>
        <span aria-hidden="true">·</span>
        <span>{objection.blocking ? "Blocking" : "Not blocking"}</span>
        <span aria-hidden="true">·</span>
        <span className="num">Round {objection.round}</span>
        {objection.call !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <span className="label accent">Your call</span>
          </>
        )}
      </div>
      <p className="issue-text">{objection.text}</p>
      <p className="issue-who">Raised by {profileText(find.profile(objection.raisedBy), find, true)}</p>
      {objection.call !== undefined && <CallWords text={objection.call} />}
      {objection.answer && (
        <div className="issue-response">
          <b>{objection.call !== undefined ? "The architect's note" : "The architect's answer"}</b>
          {objection.answer}
        </div>
      )}
      {objection.status === "noted" && (
        <div className="issue-response">
          <b>Not decided</b>
          Raised as a non-blocking suggestion after the design settled, so nobody accepted or rejected it. It stays here as a follow-up.
        </div>
      )}
      {objection.decidedBy === "coordinator" && (
        <div className="issue-response">
          <b>Your decision</b>
          You sided with the architect, so this was not taken up.
        </div>
      )}
      {objection.status !== "open" && objection.status !== "noted" && !objection.answer && objection.call === undefined && objection.decidedBy === undefined && (
        <div className="issue-response">
          <b>No reason recorded</b>
          This was settled automatically by an older version of Petrina, without anyone deciding.
        </div>
      )}
    </li>
  );
}

export function DesignView({ task, find }: { task: Task; find: Lookup }) {
  const brief = task.brief;
  return (
    <>
      {brief ? (
        <>
          <section className="sheet-section reading">
            <h2>Design brief</h2>
            <p className="prose">{brief.summary}</p>
          </section>
          <section className="sheet-section reading">
            <h2>What changes for users</h2>
            <ul className="list">
              {brief.forUsers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section className="sheet-section reading">
            <h2>Parts of the product</h2>
            <p className="prose">{brief.areas.join(", ")}</p>
          </section>
          <section className="sheet-section reading">
            <h2>Acceptance checklist</h2>
            <AcceptanceChecklist task={task} roleFor={find.role} />
          </section>
          {brief.risks.length > 0 && (
            <section className="sheet-section reading">
              <h2>Risks</h2>
              <ul className="list">
                {brief.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <div className="empty-state reading">{task.plan?.stages.some((stage) => stage.kind === "converge") ? "The architects haven't settled the brief yet." : "This plan has no design stage. The builder works from your description."}</div>
      )}

      {task.objections.length > 0 && (
        <section className="sheet-section">
          <h2>Disagreements</h2>
          <ol className="issues">
            {openFirst(task.objections).map((objection) => (
              <ObjectionItem key={objection.id} objection={objection} find={find} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

const CALL_PREVIEW = 140;

/** The coordinator's call on an objection it settled: shortened, with a way to read it all. */
function CallWords({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > CALL_PREVIEW;
  return (
    <div className="issue-response">
      <b>Your call</b>
      {all || !long ? text : `${text.slice(0, CALL_PREVIEW).trimEnd()}…`}
      {long && (
        <>
          {" "}
          <button className="linkish" onClick={() => setAll((on) => !on)}>
            {all ? "Show less" : "Read all"}
          </button>
        </>
      )}
    </div>
  );
}
