// The task sheet's Overview tab: who is working now, what the task is waiting for, what it used, and how it got here.

import { useState } from "react";
import { User } from "lucide-react";
import type { Role, State, Task } from "@petrina/core";
import { deliveryText, duration, profileText, type Lookup } from "../../lib";
import { RoleAvatar } from "../bits";
import { WhatItUsed } from "./WhatItUsed";
import { Journey } from "../Journey";
import { TimelineList } from "../Timeline";

function nowSentence(task: Task, role: Role | undefined): string {
  if (task.driving) return role ? `You're driving the ${role.name.toLowerCase()} in your terminal` : "You're driving in your terminal";
  if (task.state === "needs-you") return role ? `${role.name} is waiting on you` : "Waiting on you";
  if (task.state === "running" && role) return `${role.name} is working`;
  if (task.state === "paused") return role ? `Paused while the ${role.name.toLowerCase()} was working` : "Paused";
  switch (task.state) {
    case "queued":
      return task.held ? "On hold in the queue" : "Waiting in the queue";
    case "waiting":
      return "Waiting for a free slot";
    case "failed":
      return "Stuck. It needs you to try again or cancel";
    case "pr-open":
      return "Delivered. Waiting for you to merge it on GitHub";
    case "done":
      return deliveryText(task)?.text ?? "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Between stages";
  }
}

export function Overview({ task, state, find, onAboutNumbers, onReadSession, onPlan, separateFlow = false }: { task: Task; state: State; find: Lookup; onAboutNumbers: () => void; onReadSession: (stepId: string, name: string) => void; onPlan: () => void; separateFlow?: boolean }) {
  const [all, setAll] = useState(false);
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const entries = all ? task.timeline : task.timeline.slice(-14);

  return (
    <>
      {!separateFlow && <Journey key={task.id} task={task} state={state} find={find} onReadSession={onReadSession} onPlan={onPlan} />}

      {task.description && (
        <section className="sheet-section reading">
          <h2>What you asked for</h2>
          <p className="prose">{task.description}</p>
        </section>
      )}

      <section className="sheet-section">
        <h2>Right now</h2>
        <div className={`now ${task.state}`}>
          {role ? (
            <RoleAvatar role={role} size={32} />
          ) : (
            <span className="avatar tone-slate" style={{ width: 32, height: 32 }} aria-hidden="true">
              <User size={18} />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="who">{nowSentence(task, role)}</div>
            {profile && <div className="tool">{profileText(profile, find, true)}</div>}
            <div className="what">
              <span className={`dot ${task.state}`} aria-hidden="true" />
              <span>
                {task.statusLine}
                {task.agent && <span className="num quiet-text"> · {duration(task.driving?.since ?? task.agent.since, state.now)}</span>}
              </span>
            </div>
          </div>
        </div>
      </section>

      <WhatItUsed task={task} state={state} find={find} onAbout={onAboutNumbers} />
      {task.localUpdate && !task.localUpdate.pushed && <p className="note">{task.localUpdate.branch} was updated in the local copy. Its push to GitHub is unfinished; the work is saved.</p>}

      <section className="sheet-section">
        <h2>Timeline</h2>
        {!all && task.timeline.length > entries.length && (
          <button className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => setAll(true)}>
            Show {task.timeline.length - entries.length} earlier events
          </button>
        )}
        <TimelineList entries={entries} now={state.now} find={find} />
      </section>
    </>
  );
}
