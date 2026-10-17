// The task sheet's Overview tab: who is working now, what the task is waiting for, what it used, and how it got here.

import { useState } from "react";
import { CircleAlert, CircleCheck, User } from "lucide-react";
import type { Role, State, Task } from "@petrina/core";
import { ago, deliveryText, duration, profileText, type Lookup } from "../../lib";
import { RoleAvatar } from "../bits";
import { WhatItUsed } from "./WhatItUsed";

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

export function Overview({ task, state, find, onAboutNumbers }: { task: Task; state: State; find: Lookup; onAboutNumbers: () => void }) {
  const [all, setAll] = useState(false);
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const entries = all ? task.timeline : task.timeline.slice(-14);

  return (
    <>
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

      <section className="sheet-section">
        <h2>Timeline</h2>
        {!all && task.timeline.length > entries.length && (
          <button className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => setAll(true)}>
            Show {task.timeline.length - entries.length} earlier events
          </button>
        )}
        <ol className="timeline">
          {entries.map((entry) => {
            const entryRole = find.role(entry.roleId);
            return (
              <li key={entry.id} className={`tl ${entry.tone}`}>
                <span className="when">{ago(entry.at, state.now)}</span>
                <span className="icon" aria-hidden="true">
                  {entry.tone === "you" ? (
                    <User size={14} />
                  ) : entry.tone === "warn" ? (
                    <CircleAlert size={14} />
                  ) : entry.tone === "done" ? (
                    <CircleCheck size={14} />
                  ) : entryRole ? (
                    <RoleAvatar role={entryRole} size={24} />
                  ) : (
                    <span className="dot" />
                  )}
                </span>
                <span className="text">
                  {entryRole && entry.tone !== "you" && <span className="sr-only">{entryRole.name}: </span>}
                  {entry.text}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
