import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { Ban, Check, Flag, GitBranch, Hourglass, LoaderCircle, LocateFixed, Maximize, MessageCircle, Pencil, RotateCw, User, Wrench, X, ZoomIn, ZoomOut } from "lucide-react";
import { journeyView, journeyViewKey, landingOf, quoteTitles, type JourneyAsk, type JourneyNode, type JourneyView, type Role, type State, type Task } from "@petrina/core";
import { ago, duration, profileText, type Lookup } from "../lib";
import { layoutJourney, type EdgeKind, type ItemKind, type LaidItem } from "../journeyLayout";
import { RoleAvatar } from "./bits";
import { TimelineList } from "./Timeline";
import { StepConversation } from "./Session";
import { FindingItem } from "./sheet/ReviewTab";
import { ObjectionItem } from "./sheet/DesignTab";
import { reviewOutcome, reviewRoundGroups } from "../reviewRound";
import { ReviewRoundFindings } from "./ReviewRoundFindings";

// ── Words ───────────────────────────────────────────────────────────────────────────────

const STATE_WORDS: Record<JourneyNode["state"], string> = {
  done: "Done",
  failed: "Stuck",
  cancelled: "Cancelled",
  now: "Now",
  you: "Waiting for you",
  next: "Next",
  ahead: "Planned",
};

function stateWords(node: JourneyNode): string {
  if (node.state !== "now" || node.run === "working") return STATE_WORDS[node.state];
  return node.run === "paused" ? "Now, paused" : "Now, waiting";
}

function checkDiagnostic(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.replace(/^@[^|]+\|\s*/, "").trim());
  const failures = lines.filter((line) => /^\(fail\)\s/i.test(line));
  const causes = lines.filter((line) => /^(?:error|assertionerror):/i.test(line) || /^timed out waiting for\b/i.test(line));
  const detail = [...failures, ...causes].filter((line, index, all) => all.indexOf(line) === index).slice(0, 6).join("\n").slice(0, 1000);
  return detail || undefined;
}

/** Elapsed time from the step's start to its end (or now): pauses and waiting are not left out, so the words say elapsed. */
function timeOf(node: JourneyNode, now: number): string | undefined {
  return node.startedAt === undefined ? undefined : duration(node.startedAt, node.endedAt ?? now);
}

const elapsed = (time: string | undefined) => (time ? `${time} elapsed` : undefined);

function since(at: number, now: number): string {
  const value = ago(at, now);
  return value === "now" ? "just now" : `${value} ago`;
}

/** Every profile on the step, including the reviewers or voters working together. */
function profilesOf(node: JourneyNode, find: Lookup) {
  return (node.team ?? (node.profileId ? [node.profileId] : [])).flatMap((id) => {
    const profile = find.profile(id);
    return profile ? [profile] : [];
  });
}

/** Tool and model, or the tasks a waiting step waits for. */
function toolLine(node: JourneyNode, find: Lookup): string | undefined {
  if (node.kind === "wait") return node.waitsOn?.length ? quoteTitles(node.waitsOn.map((entry) => entry.title)) : undefined;
  return profilesOf(node, find).map((profile) => `${node.legacy ? "Planned: " : ""}${find.tool(profile.toolId)?.name ?? profile.toolId} · ${profile.model}`).join("\n") || undefined;
}

/** The last line of a box: its time and how it ended, or what it is doing now. Your steps say it in two short lines. */
function footLine(node: JourneyNode, now: number, find: Lookup): string {
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

const askKind = (ask: JourneyAsk) => (ask.kind === "question" ? "Question" : "Permission");

// Journey node names retain their full internal label for history and matching.
// The sidebar and canvas should show only the role/work name; round, retry, and
// update metadata is rendered separately as node marks. Strip all trailing
// metadata defensively so older saved journeys also get the clean label.
function visibleStepName(node: JourneyNode): string {
  return (node.flowName ?? node.name).replace(/\s+\([^)]*\)\s*$/, "");
}

/** Where a task the journey waited for stands. */
const LANDING_WORDS: Record<ReturnType<typeof landingOf>, string> = {
  landed: "landed",
  "awaiting-merge": "not landed yet: awaiting merge",
  closed: "did not land: closed without merging",
  "marked-done": "marked as done, delivery not confirmed",
  cancelled: "did not land: cancelled",
  open: "not landed yet",
};

/** One list item for screen readers: number, name, state, tool and model, time, outcome and why it moved on. */
export function spokenStep(node: JourneyNode, index: number, find: Lookup, now: number): string {
  const marks = [node.roundMark ? `round ${node.roundMark}` : "", node.updateMark ? "update" : "", node.fixMark ? `fix ${node.fixMark}` : "", node.portMark ? "port review" : "", node.callMark ? "your call" : "", node.repeatMark ? "repeated" : ""].filter(Boolean);
  const name = [visibleStepName(node), ...marks].join(", ");
  const parts = [`${index + 1}. ${name}`, stateWords(node)];
  for (const profile of profilesOf(node, find)) parts.push(`${node.legacy ? "Planned: " : ""}${profileText(profile, find, true)}`);
  if (node.kind === "wait" && node.waitsOn?.length) parts.push(`Waits for ${quoteTitles(node.waitsOn.map((entry) => entry.title))}`);
  const time = timeOf(node, now);
  if (time) parts.push(node.kind === "you" ? (node.endedAt === undefined ? `Waiting ${time} so far` : `Waited ${time}`) : node.endedAt === undefined ? `${time} elapsed so far` : `${time} elapsed`);
  const outcome = reviewOutcome(node, find.role(node.roleId));
  if (outcome) parts.push(outcome);
  else if (node.live && node.state !== "ahead") parts.push(node.live);
  if (node.reason) parts.push(`Moved on: ${node.reason}`);
  for (const ask of node.asks) parts.push(`${askKind(ask)}: ${ask.title}. ${askOutcome(ask)}`);
  return `${parts.join(". ")}.`;
}

export function startWords(view: JourneyView, now: number): string {
  if (view.start.kind === "backlog") return "In backlog";
  if (view.start.kind === "held") return "On hold";
  if (view.start.kind === "queued") return `#${view.start.position} in the queue`;
  const when = ago(view.start.at, now);
  return when === "now" ? "Started just now" : `Started ${when} ago`;
}

function useReducedMotion(): boolean {
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

// ── The diagram's boxes and arrows ──────────────────────────────────────────────────────

interface BoxData extends Record<string, unknown> {
  kind: ItemKind;
  node?: JourneyNode;
  role?: Role;
  text?: string;
  tool?: string;
  foot: string;
  endState?: NonNullable<JourneyView["end"]>["state"];
  asks: { id: string; label: string; title: string; outcome: string; open: boolean }[];
  width: number;
  height: number;
  bodyHeight: number;
  spine: number;
  selected: boolean;
  focused: boolean;
}

function Mark({ node }: { node: JourneyNode }) {
  if (node.state === "done") return <span className="jn-mark done" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>;
  if (node.state === "failed") return <span className="jn-mark failed" aria-hidden="true"><X size={12} strokeWidth={3} /></span>;
  if (node.state === "cancelled") return <span className="jn-mark cancelled" aria-hidden="true"><Ban size={12} strokeWidth={2.5} /></span>;
  return null;
}

function StepMarks({ node }: { node: JourneyNode }) {
  if (!node.roundMark && !node.updateMark && !node.repeatMark && !node.fixMark && !node.portMark && !node.callMark) return null;
  const label = [node.roundMark ? `Round ${node.roundMark}` : "", node.updateMark ? "Update" : "", node.fixMark ? `Fix ${node.fixMark}` : "", node.portMark ? "Port review" : "", node.callMark ? "Your call" : "", node.repeatMark ? "Repeated" : ""].filter(Boolean).join(", ");
  return <span className="jn-step-marks" role="img" aria-label={label} title={label}>
    {node.roundMark ? <span className="jn-round-marks" aria-hidden="true">{Array.from({ length: Math.min(node.roundMark, 5) }, (_, index) => <i key={index} className={index === Math.min(node.roundMark!, 5) - 1 ? "current" : ""} />)}</span> : null}
    {node.updateMark ? <Pencil size={11} aria-hidden="true" /> : null}
    {node.fixMark ? <span className="jn-fix-mark" aria-hidden="true"><Wrench size={10} />{node.fixMark}</span> : null}
    {node.portMark ? <GitBranch size={11} aria-hidden="true" /> : null}
    {node.callMark ? <MessageCircle size={11} aria-hidden="true" /> : null}
    {node.repeatMark ? <RotateCw size={11} aria-hidden="true" /> : null}
  </span>;
}

const JourneyBox = memo(function JourneyBox({ data }: NodeProps<Node<BoxData>>) {
  const { kind, node } = data;
  const classes = ["jn", `k-${kind}`, node ? `s-${node.state}` : undefined, node?.state === "now" ? `r-${node.run}` : undefined, node?.kind === "wait" ? "wait" : undefined, data.endState ? `e-${data.endState}` : undefined, data.selected ? "selected" : undefined, data.focused ? "focused" : undefined].filter(Boolean).join(" ");
  return (
    <div className="jn-item" style={{ width: data.width, height: data.height }}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="jn-handle" style={{ top: data.spine }} />
      <div className={classes} style={{ height: data.bodyHeight }}>
        {kind === "start" ? (
          <>
            <span className="jn-start-dot" />
            <span className="jn-point-text">{data.text}</span>
          </>
        ) : kind === "end" || kind === "rest" ? (
          <>
            {kind === "end" ? <Flag size={14} aria-hidden="true" /> : null}
            <span className="jn-point-text">{data.text}</span>
          </>
        ) : kind === "you" && node ? (
          <>
            <span className="jn-you-head">
              <span className="avatar tone-violet jn-you-icon">
                <User size={12} strokeWidth={2.4} />
              </span>
              <span className="jn-name">{visibleStepName(node)}</span>
              <Mark node={node} />
            </span>
            {(data.foot || node.roundMark || node.updateMark || node.repeatMark || node.fixMark || node.portMark || node.callMark) && <span className="jn-foot">
              {data.foot ? <span className="jn-foot-text">{data.foot.replaceAll("\n", " · ")}</span> : null}
              {data.foot && (node.roundMark || node.updateMark || node.repeatMark || node.fixMark || node.portMark || node.callMark) ? <span className="jn-foot-divider">·</span> : null}
              <StepMarks node={node} />
            </span>}
          </>
        ) : node ? (
          <>
            <span className="jn-head">
              {node.kind === "wait" ? (
                <span className="avatar tone-slate" style={{ width: 20, height: 20 }}>
                  <Hourglass size={12} strokeWidth={2.2} />
                </span>
              ) : (
                <RoleAvatar role={data.role} size={20} />
              )}
              <span className="jn-name">{visibleStepName(node)}</span>
              <Mark node={node} />
            </span>
            {data.tool && <span className="jn-tool" title={data.tool}>{data.tool}</span>}
            {(data.foot || node.roundMark || node.updateMark || node.repeatMark || node.fixMark || node.portMark || node.callMark) && (
              <span className="jn-foot">
                {node.state === "now" && <span className={`dot ${node.run === "working" ? "running" : node.run === "paused" ? "paused" : "waiting"}`} />}
                {data.foot ? <span className="jn-foot-text">{data.foot}</span> : null}{data.foot && (node.roundMark || node.updateMark || node.repeatMark || node.fixMark || node.portMark || node.callMark) ? <span className="jn-foot-divider">·</span> : null}
                <StepMarks node={node} />
              </span>
            )}
          </>
        ) : null}
      </div>
      {data.asks.length > 0 && (
        <ul className="jn-asks">
          {data.asks.map((ask) => (
            <li key={ask.id} className={`jn-ask ${ask.open ? "open" : ""}`}>
              <span className="avatar tone-violet jn-you-icon">
                <User size={10} strokeWidth={2.4} />
              </span>
              <span className="jn-ask-text">
                <span className="jn-ask-label">{ask.label}</span>
                <span className="jn-ask-title">{ask.title}</span>
                <span className="jn-ask-outcome">{ask.outcome}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className="jn-handle" style={{ top: data.spine }} />
    </div>
  );
});

interface EdgeData extends Record<string, unknown> {
  path: string;
  tipX: number;
  tipY: number;
  tip: number;
  label?: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
  kind: EdgeKind;
  labelTone: string;
  live: boolean;
  motion: boolean;
}

export const JourneyEdge = memo(function JourneyEdge({ data }: Pick<EdgeProps<Edge<EdgeData>>, "data">) {
  if (!data) return null;
  const { path, tipX, tipY, tip, label, labelX, labelY, labelWidth, kind, labelTone, live, motion } = data;
  return (
    <>
      <path className={`je-line ${kind} ${live ? "is-live" : ""} ${motion ? "moving" : ""}`} d={path} fill="none" />
      <path className={`je-tip ${kind}`} d={`M ${tipX - tip} ${tipY - tip * 0.6} L ${tipX} ${tipY} L ${tipX - tip} ${tipY + tip * 0.6} Z`} />
      {label && (
        <EdgeLabelRenderer>
          <div className={`je-label ${labelTone}`} style={{ transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY}px)`, width: labelWidth }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const NODE_TYPES = { journey: JourneyBox };
const EDGE_TYPES = { journey: JourneyEdge };
const QUIET_LABELS = { "node.a11yDescription.default": "", "node.a11yDescription.keyboardDisabled": "", "edge.a11yDescription.default": "" };
const MAX_ZOOM = 1.5;

/** Which step the diagram follows: the live one, or the end once the task is over. */
function targetOf(view: JourneyView): string {
  return view.nodes.find((node) => node.state === "now" || node.state === "you")?.id ?? (view.end ? "end" : (view.nodes.find((node) => node.state === "next")?.id ?? "start"));
}

interface DiagramProps {
  nodes: Node<BoxData>[];
  edges: Edge<EdgeData>[];
  items: readonly LaidItem[];
  contentHeight: number;
  height: number;
  target: string;
  focused?: string;
  glide: number;
  minZoom: number;
  following: boolean;
  setFollowing: (following: boolean) => void;
  onSelect: (id?: string) => void;
  scrollable?: boolean;
}

function Diagram({ nodes, edges, items, contentHeight, height, target, focused, glide, minZoom, following, setFollowing, onSelect, scrollable = false }: DiagramProps) {
  const flow = useReactFlow();
  const opened = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  // Show the live step at readable size: the whole journey when it fits, else the live step's row.
  useEffect(() => {
    if (!following) return;
    const item = items.find((entry) => entry.id === target);
    const y = contentHeight <= height || !item ? 0 : Math.max(height - contentHeight, Math.min(0, height / 2 - (item.y + item.height / 2)));
    void flow.setViewport({ x: 0, y, zoom: 1 }, { duration: opened.current ? glide : 0 });
    opened.current = true;
  }, [flow, following, items, contentHeight, height, target, glide]);

  // The box the keyboard is on comes into view.
  useEffect(() => {
    if (!focused) return;
    const item = items.find((entry) => entry.id === focused);
    const el = box.current;
    if (!item || !el) return;
    const { x, y, zoom } = flow.getViewport();
    const left = item.x * zoom + x;
    const top = item.y * zoom + y;
    const inView = left >= 0 && top >= 0 && left + item.width * zoom <= el.clientWidth && top + item.height * zoom <= el.clientHeight;
    if (inView) return;
    void flow.setCenter(item.x + item.width / 2, item.y + item.height / 2, { zoom, duration: glide });
  }, [flow, focused, items, glide]);

  // ⌘ with the scroll wheel zooms (Ctrl and pinch are React Flow's own); the wheel alone scrolls the sheet.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const { x, y, zoom } = flow.getViewport();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const next = Math.max(minZoom, Math.min(MAX_ZOOM, zoom * Math.pow(2, -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002))));
      void flow.setViewport({ x: px - (px - x) * (next / zoom), y: py - (py - y) * (next / zoom), zoom: next });
      setFollowing(false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [flow, minZoom, setFollowing]);

  const moved = () => setFollowing(false);
  return (
    <div className="journey-diagram" ref={box} style={{ height }}>
      <div className="journey-flow" aria-hidden="true">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          proOptions={{ hideAttribution: true }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={minZoom}
          maxZoom={MAX_ZOOM}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          panOnScroll={scrollable}
          preventScrolling={scrollable}
          zoomOnPinch
          zoomOnDoubleClick={false}
          panOnDrag
          zoomActivationKeyCode={null}
          panActivationKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          disableKeyboardA11y
          ariaLabelConfig={QUIET_LABELS}
          onNodeClick={(_event, node) => onSelect(node.data.node ? node.id : undefined)}
          onPaneClick={() => onSelect(undefined)}
          onMove={(event) => event && moved()}
        />
      </div>
    </div>
  );
}

/** Zoom and pan only when asked: small buttons, and Back to now once you moved away from the live step. */
function Controls({ glide, bounds, following, setFollowing }: { glide: number; bounds: { width: number; height: number }; following: boolean; setFollowing: (following: boolean) => void }) {
  const flow = useReactFlow();
  return (
    <div className="journey-controls" role="group" aria-label="Diagram view">
      {!following && (
        <button className="btn small journey-now" aria-label="Back to now" title="Back to now" onClick={() => setFollowing(true)}>
          <LocateFixed size={14} aria-hidden="true" />
          <span>Back to now</span>
        </button>
      )}
      <button className="btn quiet small icon" aria-label="Zoom in" title="Zoom in" onClick={() => { setFollowing(false); void flow.zoomIn({ duration: glide }); }}>
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button className="btn quiet small icon" aria-label="Zoom out" title="Zoom out" onClick={() => { setFollowing(false); void flow.zoomOut({ duration: glide }); }}>
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <button className="btn quiet small icon" aria-label="Show the whole journey" title="Show the whole journey" onClick={() => { setFollowing(false); void flow.fitBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height }, { padding: 0.04, duration: glide }); }}>
        <Maximize size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// ── The steps as a list, for screen readers and the keyboard ────────────────────────────

/** One tab stop; the arrow keys move through the steps, and Enter opens a step's details. */
export function JourneyList({ view, find, now, onFocusStep, onSelect }: { view: JourneyView; find: Lookup; now: number; onFocusStep: (id: string | undefined) => void; onSelect: (id: string) => void }) {
  const [active, setActive] = useState<number>();
  const live = Math.max(0, view.nodes.findIndex((node) => node.state === "now" || node.state === "you"));
  const tabStop = Math.min(active ?? live, view.nodes.length - 1);
  const list = useRef<HTMLOListElement>(null);
  const count = view.nodes.length;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    const index = tabStop;
    const target = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: count - 1 }[event.key];
    if (target !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      (list.current?.children[Math.max(0, Math.min(count - 1, target))] as HTMLElement | undefined)?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const node = view.nodes[index];
      if (node) onSelect(node.id);
    }
  };

  return (
    <ol
      ref={list}
      className="journey-list"
      aria-label={`Journey, ${count} step${count === 1 ? "" : "s"}`}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusStep(undefined);
      }}
    >
      {view.nodes.map((node, index) => (
        <li
          key={node.id}
          data-step-id={node.id}
          tabIndex={index === tabStop ? 0 : -1}
          aria-current={node.state === "now" || node.state === "you" ? "step" : undefined}
          onFocus={() => {
            setActive(index);
            onFocusStep(node.id);
          }}
          onClick={() => onSelect(node.id)}
        >
          {spokenStep(node, index, find, now)}
        </li>
      ))}
    </ol>
  );
}

// ── A step's details, under the diagram ────────────────────────────────────────────────

function StepDetails({ node, task, find, now, onPlan, onClose, onOpen }: { node: JourneyNode; task: Task; find: Lookup; now: number; onPlan: () => void; onClose?: () => void; onOpen?: (taskId: string) => void }) {
  const [activeTab, setActiveTab] = useState<"overview" | "timeline" | "conversation">("overview");
  useEffect(() => setActiveTab("overview"), [node.id]);
  const role = find.role(node.roleId);
  const profiles = profilesOf(node, find);
  const planned = node.state === "next" || node.state === "ahead";
  const entries = task.timeline.filter((entry) => entry.step === node.id);
  const lines = task.session.filter((line) => line.step === node.id);
  const checkTimeline = entries.find((entry) => entry.text.startsWith("Checks:") || entry.text.startsWith("Checks passed:"));
  const journeySteps = task.journey ?? [];
  const journeyIndex = journeySteps.findIndex((step) => step.id === node.id);
  const previousJourneyStep = journeyIndex > 0 ? journeySteps[journeyIndex - 1] : undefined;
  const ownStep = journeySteps[journeyIndex];
  const nextAgent = journeyIndex >= 0 ? journeySteps.slice(journeyIndex + 1).find((step) => step.kind === "agent") : undefined;
  const checkingThisRound = nextAgent && ownStep && nextAgent.stageId === ownStep.stageId && nextAgent.round === ownStep.round && find.role(nextAgent.roleId)?.result === "votes";
  const handedOn = nextAgent?.agentInputs?.flatMap((input) => input.sections.map((section) => section.body)).join("\n") ?? "";
  const findings = node.result?.findings ?? (role?.result === "findings" && nextAgent
    ? task.findings.filter((finding) => nextAgent.fixing && nextAgent.findingIds?.includes(finding.id) || checkingThisRound && handedOn.includes(`[${finding.id}]`)) : undefined);
  const reviewGroups = useMemo(() => role?.result === "findings" ? reviewRoundGroups(node, task.journey ?? [], (id) => find.role(id)?.result) : undefined, [role?.result, node, task.journey, find]);
  const outcome = reviewOutcome(node, role);
  const given = node.agentInputs?.flatMap((input) => input.sections.map((section) => section.body)).join("\n") ?? "";
  const objections = node.result?.objections ?? (role?.result === "objections" && ownStep
    ? task.objections.filter((objection) => objection.round === ownStep.round && (node.team ?? [node.profileId]).includes(objection.raisedBy))
    : role?.result === "brief" ? task.objections.filter((objection) => objection.answer && given.includes(`[${objection.id}]`)) : undefined);
  const latestChecksStep = [...journeySteps].reverse().find((step) => step.kind === "petrina" && step.work === "checks");
  const checksBelongHere = latestChecksStep?.id === node.id || (node.kind === "you" && node.waitsFor === "delivery" && previousJourneyStep?.id === latestChecksStep?.id);
  const currentCheckRuns = checksBelongHere && task.checks?.at !== undefined && latestChecksStep?.startedAt !== undefined && task.checks.at >= latestChecksStep.startedAt ? task.checks.results : undefined;
  const acceptanceChecks = node.acceptanceChecks ? [...node.acceptanceChecks].sort((a, b) => ({ pass: 0, blocked: 1, fail: 2 }[a.result] - { pass: 0, blocked: 1, fail: 2 }[b.result])) : [];
  const time = timeOf(node, now);
  const recorded = !planned && !node.legacy && node.startedAt !== undefined;
  // Long tasks keep only their latest timeline events and conversation lines.
  const timelineTrimmed = recorded && task.timeline.length > 0 && task.timeline[0]!.at > node.startedAt!;
  const sessionTrimmed = recorded && task.session.length > 0 && task.session[0]!.at > node.startedAt!;

  return (
    <section className="journey-details" aria-labelledby="journey-details-title">
      <div className="journey-details-head">
        <h3 id="journey-details-title">
          {node.kind === "you" ? (
            <span className="avatar tone-violet" style={{ width: 24, height: 24 }} aria-hidden="true">
              <User size={14} />
            </span>
          ) : node.kind === "wait" ? (
            <span className="avatar tone-slate" style={{ width: 24, height: 24 }} aria-hidden="true">
              <Hourglass size={14} />
            </span>
          ) : (
            <RoleAvatar role={role} size={24} />
          )}
          {visibleStepName(node)}
          <span className={`label ${node.state === "you" ? "needs-you" : node.state === "failed" ? "bad" : node.state === "now" ? "running" : node.state === "done" ? "ok" : ""}`}>{stateWords(node)}</span>
        </h3>
        {onClose && <button className="btn quiet small icon" aria-label="Close the step's details" title="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>}
      </div>

      {!planned && <div className="journey-detail-tabs" role="tablist" aria-label={`${visibleStepName(node)} details`} onKeyDown={(event) => {
        const tabs = ["overview", "timeline", "conversation"] as const;
        const current = tabs.indexOf(activeTab);
        const next = event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : current;
        if (next === current) return;
        event.preventDefault();
        setActiveTab(tabs[next]!);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-journey-tab="${tabs[next]}"]`)?.focus();
      }}>
        {(["overview", "timeline", "conversation"] as const).map((tab) => <button
          key={tab}
          type="button"
          role="tab"
          id={`journey-tab-${node.id}-${tab}`}
          aria-selected={activeTab === tab}
          aria-controls={`journey-panel-${node.id}-${tab}`}
          tabIndex={activeTab === tab ? 0 : -1}
          data-journey-tab={tab}
          onClick={() => setActiveTab(tab)}
        >{tab[0]!.toUpperCase() + tab.slice(1)}</button>)}
      </div>}

      {activeTab === "overview" && <div className="journey-tab-panel" role="tabpanel" id={`journey-panel-${node.id}-overview`} aria-labelledby={`journey-tab-${node.id}-overview`}>
      {planned ? (
        <>
          <p className="note">
            {node.kind === "you"
              ? "Planned: the squad waits here for your OK before it goes on."
              : node.kind === "petrina"
                ? "Planned: Petrina publishes the checked work itself."
                : `Planned: ${visibleStepName(node)}${profiles.length ? ` on ${profiles.map((profile) => profileText(profile, find, true)).join(" and ")}` : ""}.`}
            {node.live ? ` ${node.live}.` : ""}
          </p>
          {node.kind === "agent" && (
            <p className="note">
              Who works on a step that hasn't started can change in the Plan tab.{" "}
              <button className="linkish" onClick={onPlan}>
                Open the Plan tab
              </button>
            </p>
          )}
        </>
      ) : (
        <dl className="journey-facts">
          {profiles.length > 0 && (
            <>
              <dt>{node.legacy ? "Planned tool and model" : "Tool and model"}</dt>
              <dd>{profiles.map((profile) => <span key={profile.id} className="journey-waits">{profileText(profile, find, true)}</span>)}</dd>
            </>
          )}
          {node.kind === "wait" && node.waitsOn?.length ? (
            <>
              <dt>Waits for</dt>
              <dd>
                {node.waitsOn.map((entry) => {
                  const other = find.task(entry.id) ?? find.finishedTask(entry.id);
                  return (
                    <span key={entry.id} className="journey-waits">
                      “{other?.title ?? entry.title}” <span className="quiet-text">{other ? LANDING_WORDS[landingOf(other)] : "no longer on the board"}</span>
                    </span>
                  );
                })}
              </dd>
            </>
          ) : null}
          <dt>Started</dt>
          <dd className="num">{node.legacy || node.startedAt === undefined ? "Not recorded" : since(node.startedAt, now)}</dd>
          {time && (
            <>
              <dt>{node.kind === "you" ? (node.endedAt === undefined ? "Waiting for" : "Waited") : node.endedAt === undefined ? "Elapsed so far" : "Elapsed"}</dt>
              <dd className="num">{node.kind === "you" ? time : `${time}, including any pauses and waiting`}</dd>
            </>
          )}
          {(outcome || node.live) && (
            <>
              <dt>{outcome ? "Outcome" : "Now"}</dt>
              <dd>{outcome ?? node.live}</dd>
            </>
          )}
          {node.reason && (
            <>
              <dt>Moved on</dt>
              <dd className={node.tone === "back" ? "warn-text" : node.tone === "stuck" ? "bad-text" : ""}>{node.reason}</dd>
            </>
          )}
        </dl>
      )}

      {node.legacy && <p className="note">This step ran before Petrina kept each task's journey. Its saved profile is what was planned; who actually ran it, its time and outcome were not recorded.</p>}

      {node.kind === "agent" && (() => {
        const priorName = previousJourneyStep?.roleId
          ? find.role(previousJourneyStep.roleId)?.name ?? previousJourneyStep.roleId
          : previousJourneyStep?.kind === "petrina"
            ? previousJourneyStep.work === "checks" ? "Automated checks" : "Petrina"
            : previousJourneyStep?.kind === "you" ? "Your checkpoint" : previousJourneyStep?.kind === "wait" ? "The task dependency" : undefined;
        const priorResult = previousJourneyStep?.reason ?? previousJourneyStep?.outcome;
        const inputs = node.agentInputs ?? [];
        return <div className="journey-context">
          <h4>Why this step started</h4>
          <p>{previousJourneyStep
            ? `${priorName ?? "The previous step"}${priorResult ? ` handed it on: ${priorResult}.` : " finished, so this step began."}`
            : "This was the first agent step in the plan."}</p>
          {inputs.length > 0 ? inputs.map((input) => {
            const inputRole = find.role(input.roleId)?.name ?? input.roleId;
            const profile = find.profile(input.profileId);
            return <details className="journey-input-record" key={`${input.roleId}:${input.profileId}`}>
              <summary>Input given to {inputRole}{inputs.length > 1 && profile ? ` (${profileText(profile, find, true)})` : ""}</summary>
              <p className="quiet-text">{input.mode === "continued" ? "Updated context for its existing conversation." : "Context for a fresh conversation."}{input.stageTitle ? ` Assigned stage: ${input.stageTitle}.` : ""}</p>
              {input.taskDescription && <div>
                <h4>Task request</h4>
                <p>{input.taskDescription}</p>
              </div>}
              {input.sections.length ? input.sections.map((section) => <div key={section.title}>
                <h4>{section.title}</h4>
                <p>{section.body}</p>
              </div>) : <p className="note">No additional task context was recorded for this step.</p>}
            </details>;
          }) : <p className="note">The exact context given to this older step was not saved.</p>}
        </div>;
      })()}

      {node.kind === "agent" && node.roleId === "builder" && (
        <div className="journey-context">
          {node.fixing && (() => {
            const legacyIds = node.state === "now" && task.fixing
              ? task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing").map((finding) => finding.id)
              : node.startedAt !== undefined && node.endedAt !== undefined
                ? task.findings.filter((finding) => finding.answer && finding.answer.at >= node.startedAt! && finding.answer.at <= node.endedAt!).map((finding) => finding.id)
                : [];
            const ids = node.findingIds ?? legacyIds;
            const findings = ids.map((id) => task.findings.find((finding) => finding.id === id)).filter((finding): finding is Task["findings"][number] => !!finding);
            const journey = task.journey ?? [];
            const stepIndex = journey.findIndex((step) => step.id === node.id);
            const previous = stepIndex > 0 ? journey[stepIndex - 1] : undefined;
            const latestTesterIndex = journey.reduce((latest, step, index) => ((step.kind === "agent" && step.roleId === "tester") || (step.kind === "petrina" && step.work === "checks")) && step.endedAt !== undefined ? index : latest, -1);
            const failedChecks = previous?.acceptanceChecks?.filter((check) => check.result !== "pass")
              ?? (stepIndex - 1 === latestTesterIndex ? task.brief?.acceptance.filter((check) => check.verification === "failed" || check.verification === "blocked").map((check) => ({ text: check.text, result: check.verification === "failed" ? "fail" as const : "blocked" as const, ...(check.reason ? { reason: check.reason } : {}) })) : undefined)
              ?? [];
            return <>
              {failedChecks.length > 0 && <>
                <h4>Failed checks that triggered this fix</h4>
                <ul className="journey-check-list">{failedChecks.map((check) => <li key={check.text}><strong>{check.text}</strong>{check.reason ? <span>{check.reason}</span> : null}</li>)}</ul>
              </>}
              <h4>Findings assigned to this fix</h4>
              {findings.length ? <ul className="journey-check-list">{findings.map((finding) => (
                <li key={finding.id}><strong>{finding.text}</strong>{finding.answer ? <span>Builder’s last answer: {finding.answer.text}</span> : null}</li>
              ))}</ul> : <p className="note">This fix round’s assigned findings were not recorded.</p>}
            </>;
          })()}
        </div>
      )}

      {reviewGroups ? <ReviewRoundFindings groups={reviewGroups} find={find} {...(onOpen ? { onOpen } : {})} /> : findings !== undefined && <div className="journey-context">
        <h4>Findings from this step</h4>
        {findings.length ? <><p className="note">{node.result?.findings ? "As recorded when this step handed back its result." : "Latest recorded status of the findings handed on."}</p><ol className="issues">{findings.map((finding) => <FindingItem key={finding.id} finding={finding} find={find} {...(onOpen ? { onOpen } : {})} />)}</ol></> : <p className="note">{node.result?.findings ? "No findings were raised or confirmed." : "This step's findings were not recorded separately."}</p>}
      </div>}

      {objections !== undefined && <div className="journey-context">
        <h4>{role?.result === "brief" ? "Answers to objections" : "Objections from this step"}</h4>
        {objections.length ? <><p className="note">{node.result?.objections ? "As recorded when this step handed back its result." : "Latest recorded answers and status."}</p><ol className="issues">{objections.map((objection) => <ObjectionItem key={objection.id} objection={objection} find={find} />)}</ol></> : <p className="note">{node.result?.objections ? role?.result === "brief" ? "No objections needed an answer in this step." : "No objections were raised." : "This step's objection details were not recorded separately."}</p>}
      </div>}

      {acceptanceChecks.length ? (
        <div className="journey-context">
          <h4>Acceptance checks</h4>
          <ul className="journey-check-list">
            {acceptanceChecks.map((check) => <li key={check.text}>
              <span className={`label ${check.result === "pass" ? "ok" : check.result === "fail" ? "bad" : "needs-you"}`}>{check.result === "pass" ? "Passed" : check.result === "fail" ? "Failed" : "Could not verify"}</span>
              <strong>{check.text}</strong>
              {check.evidence ? <span>{check.evidence}</span> : null}
              {check.reason ? <span>{check.reason}</span> : null}
            </li>)}
          </ul>
        </div>
      ) : null}

      {node.kind === "petrina" && node.work === "checks" && (() => {
        const recorded = node.productChecks;
        if (recorded?.length) return <div className="journey-context">
          <h4>{recorded.some((check) => check.result === "pending" || check.result === "running") ? "Checks in this run" : "Automated check results"}</h4>
          <ul className="journey-check-list">{recorded.map((check, index) => <li key={check.id ?? `${index}-${check.name}`}>
            <span className={`label ${check.result === "pass" ? "ok" : check.result === "fail" || check.result === "did-not-finish" ? "bad" : check.result === "running" ? "running" : ""}`}>{check.result === "running" && <LoaderCircle size={12} className="check-progress-spinner" aria-hidden="true" />}{({ pass: "Passed", fail: "Failed", "did-not-finish": "Timed out", running: "Running", pending: "Pending", stopped: "Stopped", skipped: "Not needed" } as const)[check.result]}</span>
            <strong>{check.name}</strong>
            {check.startedAt !== undefined && <span className="quiet-text num">{duration(check.startedAt, check.endedAt ?? now)}{check.endedAt === undefined ? " so far" : ""}</span>}
            {check.detail ? <span className="journey-check-detail">{check.detail}</span> : null}
          </li>)}</ul>
        </div>;
        if (currentCheckRuns?.length) return <div className="journey-context">
          <h4>Automated check results</h4>
          <ul className="journey-check-list">{currentCheckRuns.map((check) => <li key={check.name}>
            <span className={`label ${check.ok ? "ok" : "bad"}`}>{check.ok ? "Passed" : check.timedOut ? "Timed out" : "Failed"}</span>
            <strong>{check.name}</strong>
            {!check.ok && checkDiagnostic(check.output) ? <span className="journey-check-detail">{checkDiagnostic(check.output)}</span> : null}
          </li>)}</ul>
        </div>;
        if (checkTimeline) return <div className="journey-context">
          <h4>Automated check results</h4>
          <p>{checkTimeline.text}</p>
        </div>;
        return null;
      })()}

      {node.kind === "you" && node.waitsFor === "delivery" && currentCheckRuns?.some((check) => !check.ok) && <div className="journey-context">
        <h4>Checks behind this delivery decision</h4>
        <ul className="journey-check-list">{currentCheckRuns.map((check) => <li key={check.name}>
          <span className={`label ${check.ok ? "ok" : "bad"}`}>{check.ok ? "Passed" : check.timedOut ? "Timed out" : "Failed"}</span>
          <strong>{check.name}</strong>
          {!check.ok && checkDiagnostic(check.output) ? <span className="journey-check-detail">{checkDiagnostic(check.output)}</span> : null}
        </li>)}</ul>
      </div>}

      {node.asks.length > 0 && (
        <div className="journey-asked">
          <h4>What it asked you</h4>
          <ul>
            {node.asks.map((ask) => (
              <li key={ask.id} className={ask.endedAt === undefined ? "open" : ""}>
                <span className="quiet-text num">
                  {askKind(ask)} · {ask.endedAt === undefined ? `waiting ${duration(ask.at, now)}` : `waited ${duration(ask.at, ask.endedAt)}`}
                </span>
                <span className="journey-ask-title">{ask.title}</span>
                <span className={ask.endedAt === undefined ? "warn-text" : ""}>{askOutcome(ask)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>}

      {activeTab === "timeline" && <div className="journey-tab-panel" role="tabpanel" id={`journey-panel-${node.id}-timeline`} aria-labelledby={`journey-tab-${node.id}-timeline`}>
      {recorded ? (
        <div className="journey-part">
          <h4>This step on the timeline</h4>
          {entries.length > 0 ? <TimelineList entries={entries} now={now} find={find} /> : null}
          {timelineTrimmed && (
            <p className="note">{entries.length ? "Its earliest events are no longer kept: long tasks keep only their latest timeline events." : "Its part of the timeline is no longer kept: long tasks keep only their latest timeline events."}</p>
          )}
          {!entries.length && !timelineTrimmed && <p className="note">Nothing on the timeline yet.</p>}
        </div>
      ) : <p className="note">This step has no recorded timeline.</p>}
      </div>}

      {activeTab === "conversation" && <div className="journey-tab-panel" role="tabpanel" id={`journey-panel-${node.id}-conversation`} aria-labelledby={`journey-tab-${node.id}-conversation`}>
        {lines.length > 0 ? <StepConversation lines={lines} find={find} now={now} live={node.state === "now" || node.state === "you"} taskId={task.id} repositories={task.repositories} finished={task.state === "done" || task.state === "cancelled"} /> : sessionTrimmed ? <p className="note">This step’s earlier conversation is no longer kept; long tasks retain only the latest lines.</p> : <p className="note">No agent conversation was recorded for this step.</p>}
      </div>}
    </section>
  );
}

// ── The Journey section ────────────────────────────────────────────────────────────────

interface JourneyProps {
  task: Task;
  state: State;
  find: Lookup;
  onReadSession: (stepId: string, name: string) => void;
  onPlan: () => void;
  /** Open the task a finding links to: a Backlog card, or the finished task it came from. */
  onOpenTask?: (taskId: string) => void;
  /** A dedicated canvas column, with the selected step rendered in its neighbour. */
  workspace?: boolean;
  detailsTarget?: HTMLElement | null;
  onSelectionChange?: (id?: string) => void;
  selectedStep?: string;
}

/** The task's journey as a live diagram, the same steps as a list, and the chosen step's details. */
export function Journey(props: JourneyProps) {
  return (
    <ReactFlowProvider>
      <JourneyBody {...props} />
    </ReactFlowProvider>
  );
}

function JourneyBody({ task, state, find, onPlan, onOpenTask, workspace = false, detailsTarget, onSelectionChange, selectedStep }: JourneyProps) {
  const viewKey = journeyViewKey(task, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });
  const view = useMemo(
    () => journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) }),
    // A WebSocket update replaces every task object, including the long conversation history. Only
    // rebuild the diagram when one of the small set of fields that affects it actually changes.
    [viewKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [localSelection, setSelected] = useState<string>();
  const selected = workspace ? selectedStep : localSelection;
  const [focused, setFocused] = useState<string>();
  const reduced = useReducedMotion();
  const [following, setFollowing] = useState(true);
  const canvas = useRef<HTMLDivElement>(null);
  const remProbe = useRef<HTMLSpanElement>(null);
  const labelProbe = useRef<HTMLSpanElement>(null);
  const [fontEpoch, setFontEpoch] = useState(0);
  const [space, setSpace] = useState({ width: 0, rem: 16, cap: 448 });

  // Rows re-wrap when the sheet or the text size changes. Enlarged text may leave the sheet's width as it
  // is, so a hidden square 1rem wide is watched as well: it resizes whenever the text size does.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () =>
      setSpace((old) => {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const next = { width: el.clientWidth, rem, cap: workspace ? el.clientHeight : Math.round(Math.max(18 * rem, Math.min(28 * rem, window.innerHeight * 0.55))) };
        return old.width === next.width && old.rem === next.rem && old.cap === next.cap ? old : next;
      });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(el);
    if (remProbe.current) observer?.observe(remProbe.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [workspace]);

  // A loaded font can change line wrapping without changing the panel or root text size.
  useEffect(() => {
    let mounted = true;
    const changed = () => { if (mounted) setFontEpoch((epoch) => epoch + 1); };
    const fonts = document.fonts;
    void fonts?.ready?.then(changed);
    fonts?.addEventListener("loadingdone", changed);
    return () => { mounted = false; fonts?.removeEventListener("loadingdone", changed); };
  }, []);

  const start = startWords(view, state.now);
  // Only a change to the journey's shape moves boxes: a new status line or a ticking clock does not.
  const shape = JSON.stringify([start, view.end?.text, view.rest, view.nodes.map((node) => [node.id, node.kind, node.state, node.run, node.tone, node.reason, node.asks.length, node.team?.length])]);
  const layout = useMemo(() => {
    const probe = labelProbe.current;
    const measurements = new Map<string, { width: number; height: number }>();
    // Measure outside the zoomed canvas, with the arrow label's actual type and wrapping. This only
    // runs when the journey's shape, panel, text size or font changes, never on each status update.
    const measure = probe && probe.getBoundingClientRect().height ? (text: string, maxWidth: number) => {
      const key = JSON.stringify([text, maxWidth]);
      const cached = measurements.get(key);
      if (cached) return cached;
      probe.style.maxWidth = `${maxWidth}px`;
      probe.textContent = text;
      const rect = probe.getBoundingClientRect();
      const measured = { width: rect.width, height: rect.height };
      measurements.set(key, measured);
      return measured;
    } : undefined;
    return layoutJourney(view, space.width || 760, space.rem, start, measure);
  }, [shape, space.width, space.rem, fontEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = targetOf(view);
  useEffect(() => { if (selected && selected !== target) setFollowing(false); }, [selected, target]);
  // The live step handing off while someone reads it (its details open, or the keyboard on it): the diagram stays with it.
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== lastTarget) {
    setLastTarget(target);
    if (following && (selected === lastTarget || focused === lastTarget)) setFollowing(false);
  }

  const cache = useRef(new Map<string, { key: string; node: Node<BoxData> }>());
  const byId = useMemo(() => new Map(view.nodes.map((node) => [node.id, node])), [view]);
  const selectedId = selected;
  const nodes = useMemo(
    () =>
      layout.items.map((item) => {
        const node = byId.get(item.id);
        const data: BoxData = {
          kind: item.kind,
          ...(node ? { node } : {}),
          ...(node?.roleId && find.role(node.roleId) ? { role: find.role(node.roleId)! } : {}),
          ...(item.kind === "start" ? { text: start } : item.kind === "end" ? { text: view.end?.text ?? "", endState: view.end?.state ?? "done" } : item.kind === "rest" ? { text: view.rest ?? "" } : {}),
          ...(node && toolLine(node, find) ? { tool: toolLine(node, find)! } : {}),
          foot: node ? footLine(node, state.now, find) : "",
          asks: (node?.asks ?? []).map((ask) => ({ id: ask.id, label: `${askKind(ask)} · ${duration(ask.at, ask.endedAt ?? state.now)}`, title: ask.title, outcome: askOutcome(ask), open: ask.endedAt === undefined })),
          width: item.width,
          height: item.height,
          bodyHeight: item.bodyHeight,
          spine: item.spine,
          selected: item.id === selectedId,
          focused: item.id === focused,
        };
        const key = JSON.stringify([item.x, item.y, data]);
        const hit = cache.current.get(item.id);
        if (hit && hit.key === key) return hit.node;
        const made: Node<BoxData> = { id: item.id, type: "journey", position: { x: item.x, y: item.y }, data, width: item.width, height: item.height, draggable: false, selectable: false, connectable: false };
        cache.current.set(item.id, { key, node: made });
        return made;
      }),
    [layout, byId, find, start, view.end, view.rest, state.now, selectedId, focused],
  );
  const edges = useMemo(
    () =>
      layout.edges.map((edge): Edge<EdgeData> => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "journey",
        data: { path: edge.path, tipX: edge.tipX, tipY: edge.tipY, tip: Math.round(space.rem * 0.5), ...(edge.label ? { label: edge.label } : {}), labelX: edge.labelX, labelY: edge.labelY, labelWidth: edge.labelWidth, kind: edge.kind, labelTone: edge.labelTone, live: edge.live, motion: edge.live && !reduced },
        selectable: false,
        focusable: false,
      })),
    [layout, reduced, space.rem],
  );

  // Reading another step stops following the live one, and reading the live one stops it once it hands off,
  // so a handoff never moves the diagram away. Back to now resumes.
  const select = (id?: string) => {
    const next = workspace && id === selected ? undefined : id;
    if (!workspace) setSelected(next);
    onSelectionChange?.(next);
    if (next && next !== target) setFollowing(false);
  };
  const focusStep = (id: string | undefined) => {
    setFocused(id);
    if (id && id !== target) setFollowing(false);
  };
  const chosen = selectedId ? byId.get(selectedId) : undefined;
  const height = workspace ? Math.max(1, space.cap) : Math.min(layout.height, space.cap);
  const glide = reduced ? 0 : 280;
  const minZoom = Math.min(0.25, height / Math.max(1, layout.height));

  return (
    <section className={`sheet-section journey ${workspace ? "workspace-journey" : ""}`} aria-labelledby="journey-title">
      <div className="journey-head">
        <h2 id="journey-title">Task flow <span className="quiet-text num">{view.nodes.length} steps</span></h2>
        <Controls glide={glide} bounds={layout} following={following} setFollowing={setFollowing} />
      </div>
      <p className="sr-only">{start}.</p>
      <JourneyList view={view} find={find} now={state.now} onFocusStep={focusStep} onSelect={select} />
      {view.end && <p className="sr-only">{view.end.text}.</p>}
      {view.rest && <p className="sr-only">{view.rest}.</p>}
      <div className="journey-canvas" ref={canvas}>
        <span className="journey-rem" ref={remProbe} aria-hidden="true" />
        <span className="journey-label-measure" ref={labelProbe} aria-hidden="true" />
        <Diagram nodes={nodes} edges={edges} items={layout.items} contentHeight={layout.height} height={height} target={target} {...(focused || selected ? { focused: focused ?? selected } : {})} glide={glide} minZoom={minZoom} following={following} setFollowing={setFollowing} onSelect={select} scrollable={workspace} />
      </div>
      <p className="sr-only" aria-live="polite">
        {chosen ? `${chosen.name}: its details are ${workspace ? "in the right panel" : "below the diagram"}.` : ""}
      </p>
      {workspace ? detailsTarget && createPortal(chosen ? <StepDetails key={chosen.id} node={chosen} task={task} find={find} now={state.now} onPlan={onPlan} {...(onOpenTask ? { onOpen: onOpenTask } : {})} /> : selected ? <p className="empty-state">This step is no longer available in this task's flow. Go back to the task or choose another step.</p> : null, detailsTarget) : chosen ? (
        <StepDetails node={chosen} task={task} find={find} now={state.now} onPlan={onPlan} onClose={() => setSelected(undefined)} {...(onOpenTask ? { onOpen: onOpenTask } : {})} />
      ) : (
        <p className="note journey-hint">Click a step to see its details here.</p>
      )}
    </section>
  );
}
