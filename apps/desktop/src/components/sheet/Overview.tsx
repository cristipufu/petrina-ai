// The task sheet's Overview tab: who is working now, what the task is waiting for, what it used, and how it got here.

import { useState } from "react";
import { Monitor, User } from "lucide-react";
import { SCREEN_WORDS, mainLine, nextLine, screenWait, timeLeft, workedSoFar, type Role, type State, type Task } from "@petrina/core";
import { deliveryText, duration, profileText, type Lookup } from "../../lib";
import { failureText, sim } from "../../engine";
import { RoleAvatar } from "../bits";
import { WhatItUsed } from "./WhatItUsed";
import { Journey } from "../Journey";
import { TimelineList } from "../Timeline";

function nowSentence(task: Task, role: Role | undefined, state: State): string {
  if (task.driving) return role ? `You're driving the ${role.name.toLowerCase()} in your terminal` : "You're driving in your terminal";
  const screen = screenWait(task, state, state.now);
  if (screen) return screen === "ask" ? `${role?.name ?? "The agent"} needs the screen. Waiting for your OK` : SCREEN_WORDS.turn;
  if (task.state === "needs-you") return role ? `${role.name} is waiting on you` : "Waiting on you";
  if (task.state === "running" && role) return `${role.name} is working`;
  if (task.state === "paused") return role ? `Paused while the ${role.name.toLowerCase()} was working` : "Paused";
  switch (task.state) {
    case "backlog":
      return "Review before queuing";
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

/**
 * Right now, in lines: what the agent is working on (its to-do item, with the time it has worked on
 * this step), or what it waits for; then, quieter, its latest action, or the to-do item it was on
 * when it stopped to wait for the coordinator. Each is left out when it says nothing new.
 */
function nowLines(task: Task, state: State): { first: string; time?: string; second?: string } {
  const working = task.state === "running";
  const waitingOnYou = task.state === "needs-you" && state.inbox.some((item) => item.taskId === task.id && item.blocking);
  // While the coordinator drives, how long they have; otherwise how long the agent has worked on this step, without waits.
  const time = !task.agent
    ? undefined
    : task.driving
      ? duration(task.driving.since, state.now)
      : task.stepClock
        ? duration(state.now - workedSoFar(task.stepClock, state.now), state.now)
        : duration(task.agent.since, state.now);
  const first = mainLine(task);
  if (working) return { first, ...(time ? { time } : {}), ...(task.statusLine !== first ? { second: task.statusLine } : {}) };
  return { first: task.statusLine, ...(time ? { time } : {}), ...(waitingOnYou && task.todo && task.todo !== task.statusLine ? { second: task.todo } : {}) };
}

export function Overview({ task, state, find, onAboutNumbers, onReadSession, onPlan, separateFlow = false }: { task: Task; state: State; find: Lookup; onAboutNumbers: () => void; onReadSession: (stepId: string, name: string) => void; onPlan: () => void; separateFlow?: boolean }) {
  const [all, setAll] = useState(false);
  // Waiting for the screen, the agent that asked is still the one this step is about.
  const role = find.role(task.agent?.roleId ?? task.screen?.roleId);
  const profile = find.profile(task.agent?.profileId ?? task.screen?.profileId);
  const screenAsk = screenWait(task, state, state.now) === "ask";
  const entries = all ? task.timeline : task.timeline.slice(-14);
  const now = nowLines(task, state);
  const left = timeLeft(state, task);
  const next = nextLine(state, task);

  return (
    <>
      {!separateFlow && <Journey key={task.id} task={task} state={state} find={find} onReadSession={onReadSession} onPlan={onPlan} />}

      {task.state === "backlog" && <BacklogRequest key={task.id} task={task} />}
      {task.description && task.state !== "backlog" && (
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
            <div className="who">{nowSentence(task, role, state)}</div>
            {profile && <div className="tool">{profileText(profile, find, true)}</div>}
            <div className="what">
              <span className={`dot ${task.state}`} aria-hidden="true" />
              <span>
                {now.first}
                {now.time && <span className="num quiet-text"> · {now.time}</span>}
              </span>
            </div>
            {now.second && <div className="now-line">{now.second}</div>}
            {left && <div className="now-line num">{left}</div>}
            {next && <div className="now-line">{next}</div>}
            {screenAsk && (
              <button className="btn small outline now-action" onClick={() => sim.allowScreen(task.id)}>
                <Monitor size={16} aria-hidden="true" />
                Allow now
              </button>
            )}
          </div>
        </div>
      </section>

      {task.repositories && <section className="sheet-section reading" id="task-deliveries"><h2>Changes and deliveries</h2>
        {task.repositories.map((work) => <div className="repository-row" key={work.productId}>
          <h3>{work.source?.product.name ?? work.productId}{work.removed ? " · removed" : ""}</h3><p className="note">{work.source?.product.repo}</p>
          <p className="prose">{work.report?.summary ?? "No changes reported yet"}</p>
          <ul>{work.report?.changes.map((change) => <li key={change}>{change}</li>)}</ul>
          <p className="note">Product checks: {!work.checks?.results.length ? "Not run" : work.checks.current === false ? "Not current" : work.checks.results.some((run) => !run.ok) ? "Failed" : "Passed"}{work.checks?.sha ? ` · version ${work.checks.sha.slice(0, 7)}` : ""}</p>
          <p className="prose">{work.nothingToPublish ? "Nothing to publish" : work.pr ? <a href={work.pr.url} target="_blank" rel="noreferrer">Pull request #{work.pr.number} · {work.pr.state === "open" ? "waiting for merge" : work.pr.state === "merged" ? "merged" : work.landingAccepted ? "closed without merging · resolved by you" : "closed without merging · your decision needed"}</a> : work.release ? <a href={work.release.url} target="_blank" rel="noreferrer">Release {work.release.tag}</a> : work.localUpdate ? `${work.localUpdate.branch}: committed locally${work.localUpdate.pushed ? " and push confirmed" : " · push unfinished"}` : work.shipping?.step ? "Delivery needs checking before retry" : "Delivery waiting"}</p>
          {work.source && <p className="note">{work.source.destination.repo} · {work.source.destination.branch}</p>}
          {work.releasePreview && <div><p>Release {work.releasePreview.tag} includes everything waiting on the default branch since its previous release.</p><p className="prose">{work.releasePreview.notes}</p></div>}
          {work.companion && <p className="note">{work.companion.state === "done" ? "Companion links finished" : "Companion links need finishing"}</p>}
        </div>)}
        <h3>Together</h3>{task.sharedLessons?.map((lesson, index) => <p className="note" key={index}>Lesson needs a product assignment: {lesson.text}</p>)}<p className="note">{task.acceptancePassed === true ? "Shared acceptance passed" : task.acceptancePassed === false ? "Shared acceptance needs attention" : "Shared acceptance not yet verified"}</p>
        {task.brief?.acceptance.map((item) => <p className="prose" key={item.text}>{item.text}: {item.verification === "passed" ? "Passed" : item.verification === "failed" ? "Failed" : "Not verified"}</p>)}
      </section>}
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

function BacklogRequest({ task }: { task: Task }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changed = title.trim() !== task.title || description.trim() !== task.description;
  const save = async (queue: boolean) => {
    setSaving(true); setError("");
    try {
      if (changed) await sim.updateBacklog(task.id, { title, description });
      if (queue) await sim.queueTask(task.id);
    } catch (problem) { setError(failureText(problem)); }
    finally { setSaving(false); }
  };
  return <section className="sheet-section backlog-request">
    <h2>Review the request</h2>
    <p className="quiet-text">Nothing starts from the backlog. Check the request, then queue it when it is ready.</p>
    <label>Task title<input className="input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} disabled={saving} /></label>
    <label>Details<textarea className="details" value={description} maxLength={8000} onChange={(event) => setDescription(event.target.value)} disabled={saving} /></label>
    {error && <p className="note bad" role="alert">{error}</p>}
    <div className="row" style={{ gap: 8 }}>
      <button className="btn outline" disabled={!changed || !title.trim() || saving} onClick={() => void save(false)}>Save changes</button>
      <button className="btn lead" disabled={!title.trim() || saving} onClick={() => void save(true)}>{saving ? "Saving…" : "Queue for work"}</button>
    </div>
  </section>;
}
