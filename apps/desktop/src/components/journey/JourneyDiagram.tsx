import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { EdgeLabelRenderer, Handle, Position, ReactFlow, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { Ban, Check, Flag, GitBranch, Hourglass, LocateFixed, Maximize, MessageCircle, Pencil, RotateCw, User, Wrench, X, ZoomIn, ZoomOut } from "lucide-react";
import type { JourneyNode, JourneyView, Role } from "@petrina/core";
import type { Lookup } from "../../lib";
import type { EdgeKind, ItemKind, LaidItem } from "../../journeyLayout";
import { RoleAvatar } from "../bits";
import { spokenStep, visibleStepName } from "./journeyWords";

export interface BoxData extends Record<string, unknown> {
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

export interface EdgeData extends Record<string, unknown> {
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

export interface DiagramProps {
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

export function Diagram({ nodes, edges, items, contentHeight, height, target, focused, glide, minZoom, following, setFollowing, onSelect, scrollable = false }: DiagramProps) {
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
    if (inView) {
      // A previous pan may still be headed elsewhere. Keep this step in view when focus moves quickly.
      void flow.setViewport({ x, y, zoom });
      return;
    }
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
          onlyRenderVisibleElements
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
export function Controls({ glide, bounds, following, setFollowing }: { glide: number; bounds: { width: number; height: number }; following: boolean; setFollowing: (following: boolean) => void }) {
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
