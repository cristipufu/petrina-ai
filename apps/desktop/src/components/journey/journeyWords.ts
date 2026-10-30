import { useEffect, useMemo, useState } from "react";
import { dependencyLanding, profileModelName, quoteTitles, type JourneyAsk, type JourneyNode, type JourneyView } from "@petrina/core";
import { ago, duration, profileText, type Lookup } from "../../lib";
import { reviewOutcome } from "../../reviewRound";

export const STATE_WORDS: Record<JourneyNode["state"], string> = {
  done: "Done",
  failed: "Stuck",
  cancelled: "Cancelled",
  now: "Now",
  you: "Waiting for you",
  next: "Next",
  ahead: "Planned",
};

export function stateWords(node: JourneyNode): string {
  if (node.state !== "now" || node.run === "working") return STATE_WORDS[node.state];
  return node.run === "paused" ? "Now, paused" : "Now, waiting";
}

/** Elapsed time from the step's start to its end (or now): pauses and waiting are not left out, so the words say elapsed. */
export function timeOf(node: JourneyNode, now: number): string | undefined {
  return node.work === "check-reuse" || node.startedAt === undefined ? undefined : duration(node.startedAt, node.endedAt ?? now);
}

const elapsed = (time: string | undefined) => (time ? `${time} elapsed` : undefined);

export function since(at: number, now: number): string {
  const value = ago(at, now);
  return value === "now" ? "just now" : `${value} ago`;
}

/** Every profile on the step, including the reviewers or voters working together. */
export function profilesOf(node: JourneyNode, find: Lookup) {
  return (node.team ?? (node.profileId ? [node.profileId] : [])).flatMap((id) => {
    const profile = find.profile(id);
    return profile ? [profile] : [];
  });
}

/** Tool and model, or the tasks a waiting step waits for. */
export function toolLine(node: JourneyNode, find: Lookup): string | undefined {
  let line: string | undefined;
  if (node.kind === "wait") {
    line = node.waitStates ? node.waitsOn?.map((entry) => {
      const state = node.waitStates?.find((saved) => saved.id === entry.id)?.state;
      return `“${entry.title}”${state ? ` · ${state}` : ""}`;
    }).join(", ") : node.waitsOn?.length ? quoteTitles(node.waitsOn.map((entry) => entry.title)) : undefined;
  } else {
    line = profilesOf(node, find).map((profile) => `${node.legacy ? "Planned: " : ""}${find.tool(profile.toolId)?.name ?? profile.toolId} · ${profileModelName(profile)}`).join("\n");
  }
  return [line, node.waitReason].filter(Boolean).join("\n") || undefined;
}

/** The last line of a box: its time and how it ended, or what it is doing now. Your steps say it in two short lines. */
export function footLine(node: JourneyNode, now: number, find: Lookup): string {
  const time = timeOf(node, now);
  const outcome = reviewOutcome(node, find.role(node.roleId));
  if (node.kind === "you") {
    if (node.state === "you") return ["Waiting for you", time ? `${time} so far` : undefined].filter(Boolean).join("\n");
    if (node.state === "next" || node.state === "ahead") return node.state === "next" ? "Next" : "";
    return [node.outcome, time ? `Waited ${time}` : undefined].filter(Boolean).join("\n");
  }
  switch (node.state) {
    case "next":
      return ["Next", node.live].filter(Boolean).join(" · ");
    case "ahead":
      return "";
    case "now":
    case "you":
      return [elapsed(time), node.live].filter(Boolean).join(" · ");
    default:
      return [elapsed(time), outcome].filter(Boolean).join(" · ");
  }
}

export function askOutcome(ask: JourneyAsk): string {
  switch (ask.how) {
    case "answered":
      return `You answered: ${ask.answer ?? ""}`;
    case "decided":
      return `Decided for you: ${ask.answer ?? ""}`;
    case "allowed":
      return "You allowed it";
    case "denied":
      return ask.answer ? `You said no: ${ask.answer}` : "You said no";
    case "withdrawn":
      return "Withdrawn";
    default:
      return "Waiting for you";
  }
}

export const askKind = (ask: JourneyAsk) => (ask.kind === "question" ? "Question" : "Permission");

// Journey node names retain their full internal label for history and matching.
// The sidebar and canvas should show only the role/work name; round, retry, and
// update metadata is rendered separately as node marks. Strip all trailing
// metadata defensively so older saved journeys also get the clean label.
export function visibleStepName(node: JourneyNode): string {
  return (node.flowName ?? node.name).replace(/\s+\([^)]*\)\s*$/, "");
}

/** Where a task the journey waited for stands. */
export const LANDING_WORDS: Record<ReturnType<typeof dependencyLanding>, string> = {
  landed: "landed",
  "awaiting-merge": "not landed yet: awaiting merge",
  closed: "did not land: closed without merging",
  "marked-done": "marked as done, delivery not confirmed",
  "no-changes": "completed without product changes",
  cancelled: "did not land: cancelled",
  open: "not landed yet",
};

/** A line said as one sentence: its own closing period is not doubled. */
export const unstopped = (text: string) => text.replace(/\.+$/, "");

/** One list item for screen readers: number, name, state, tool and model, time, outcome and why it moved on. */
export function spokenStep(node: JourneyNode, index: number, find: Lookup, now: number): string {
  const marks = [node.roundMark ? `round ${node.roundMark}` : "", node.updateMark ? "update" : "", node.fixMark ? `fix ${node.fixMark}` : "", node.portMark ? "port review" : "", node.callMark ? "your call" : "", node.repeatMark ? "repeated" : ""].filter(Boolean);
  const name = [visibleStepName(node), ...marks].join(", ");
  const parts = [`${index + 1}. ${name}`, stateWords(node)];
  for (const profile of profilesOf(node, find)) parts.push(`${node.legacy ? "Planned: " : ""}${profileText(profile, find, true)}`);
  if (node.kind === "wait" && node.waitsOn?.length) parts.push(`Waits for ${quoteTitles(node.waitsOn.map((entry) => entry.title))}`);
  if (node.waitReason) parts.push(`Reason for waiting: ${node.waitReason}`);
  const time = timeOf(node, now);
  if (time) parts.push(node.kind === "you" ? (node.endedAt === undefined ? `Waiting ${time} so far` : `Waited ${time}`) : node.endedAt === undefined ? `${time} elapsed so far` : `${time} elapsed`);
  const outcome = reviewOutcome(node, find.role(node.roleId));
  if (outcome) parts.push(outcome);
  else if (node.live && node.state !== "ahead") parts.push(unstopped(node.live));
  if (node.reason) parts.push(`${node.state === "failed" ? "Stopped because" : "Moved on"}: ${node.reason}`);
  for (const ask of node.asks) parts.push(`${askKind(ask)}: ${ask.title}. ${askOutcome(ask)}`);
  return `${parts.join(". ")}.`;
}

export function startWords(view: JourneyView, now: number): string {
  if (view.start.kind === "backlog") return "In backlog";
  if (view.start.kind === "held") return "On hold";
  if (view.start.kind === "queued") return `#${view.start.position} in the queue`;
  const when = ago(view.start.at, now);
  const label = view.start.kind === "created" ? "Created" : "Started";
  return when === "now" ? `${label} just now` : `${label} ${when} ago`;
}

export function useReducedMotion(): boolean {
  const query = useMemo(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined, []);
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    onChange();
    return () => query.removeEventListener?.("change", onChange);
  }, [query]);
  return reduced;
}

/** Which step the diagram follows: the live one, or the end once the task is over. */
export function targetOf(view: JourneyView): string {
  return view.nodes.find((node) => node.state === "now" || node.state === "you")?.id ?? (view.end ? "end" : (view.nodes.find((node) => node.state === "next")?.id ?? "start"));
}
