// The task sheet's Overview tab: who is working now, what the task is waiting for, what it used, and how it got here.

import { useState } from "react";
import { Monitor, User } from "lucide-react";
import { occurrenceText, SCREEN_WORDS, mainLine, nextLine, screenWait, timeLeft, workedSoFar, type Role, type State, type Task } from "@petrina/core";
import { deliveryText, duration, profileText, type Lookup } from "../../lib";
import { failureText, sim } from "../../engine";
import { RoleAvatar } from "../bits";
import { ImagePreview } from "../MessageBody";
import { WhatItUsed } from "./WhatItUsed";
import { Journey } from "../Journey";
import { TimelineList } from "../Timeline";
import { TaskLink } from "./ReviewTab";

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
      return task.combinedInto ? "Combined into another task" : "Cancelled";
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

export function Overview({ task, state, find, onAboutNumbers, onReadSession, onPlan, onOpenTask, separateFlow = false }: { task: Task; state: State; find: Lookup; onAboutNumbers: () => void; onReadSession: (stepId: string, name: string) => void; onPlan: () => void; onOpenTask?: (taskId: string) => void; separateFlow?: boolean }) {
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
      {task.maintenance && <section className="sheet-section reading"><h2>Scheduled routine</h2><p>{task.maintenance.routineName}</p><p>{occurrenceText(task.maintenance.scheduledAt, task.maintenance.zone)}</p>{task.maintenance.catchUp && <p>{task.maintenance.catchUp}</p>}<p>{task.maintenance.role.name} · {profileText(task.maintenance.profile, find, true)}</p>{task.maintenance.noProductChanges && <p>Completed · No product changes</p>}{task.maintenance.settingsDecision && <p>Requested: {task.maintenance.settingsDecision.requested}<br />Reported: {task.maintenance.settingsDecision.actual}<br />{task.maintenance.settingsDecision.choice === "keep" ? "You kept this run with its reported settings." : task.maintenance.settingsDecision.choice === "stop" ? "You stopped this run." : "Waiting for your decision in Inbox."}</p>}</section>}
      {task.combinedInto && <section className="sheet-section reading"><h2>Combined request</h2><p>This request is part of <TaskLink taskId={task.combinedInto} find={find} onOpen={onOpenTask}>the combined task</TaskLink>.</p></section>}
      {task.combinedFrom?.length && <section className="sheet-section reading"><h2>Original requests</h2><ul>{task.combinedFrom.map((source) => <li key={source.id}><TaskLink taskId={source.id} find={find} onOpen={onOpenTask}>{source.title}</TaskLink></li>)}</ul></section>}
      {!separateFlow && <Journey key={task.id} task={task} state={state} find={find} onReadSession={onReadSession} onPlan={onPlan} {...(onOpenTask ? { onOpenTask } : {})} />}

      {task.followUp && <FollowUpReports task={task} find={find} {...(onOpenTask ? { onOpenTask } : {})} />}
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

function FollowUpReports({ task, find, onOpenTask }: { task: Task; find: Lookup; onOpenTask?: (taskId: string) => void }) {
  const reports = task.followUp?.reports ?? [];
  const names = (ids: readonly string[]) => ids.map((id) => find.product(id)?.name ?? id).join(", ");
  const covered = [...new Set((task.selectedProducts?.length ? task.selectedProducts.map((choice) => choice.productId) : reports.flatMap((report) => report.productIds)).filter(Boolean))];
  const pictures = task.session.flatMap((line) => line.images ?? []);
  const finished = task.state === "done" || task.state === "cancelled";
  return <section className="sheet-section reading">
    <h2>Where this came from</h2>
    {!!covered.length && <p className="issue-who">Products: {names(covered)}</p>}
    {!!task.followUp?.alsoReported?.length && <p className="issue-who">Also reported on {names(task.followUp.alsoReported)}. Not part of this work.</p>}
    {reports.map((report) => <div className="issue" key={`${report.taskId}-${report.findingId}`}>
      <p className="issue-text">{report.text}</p>
      <p className="issue-evidence">How to see it again: {report.steps}</p>
      <p className="issue-evidence">Why the change left it as it was: {report.evidence}</p>
      {!!report.reasons?.length && <p className="issue-evidence">Checked as older: {report.reasons.join(" ")}</p>}
      <p className="issue-who">
        Found by {report.roleId && find.role(report.roleId) ? `${find.role(report.roleId)!.name} on ` : ""}{profileText(find.profile(report.raisedBy), find, true)}. From <TaskLink taskId={report.taskId} find={find} {...(onOpenTask ? { onOpen: onOpenTask } : {})}>{report.sourceTitle}</TaskLink>
      </p>
    </div>)}
    {pictures.map((image) => <ImagePreview key={image.id} taskId={task.id} imageId={image.id} label={image.caption || "Screenshot"} finished={finished} />)}
  </section>;
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
