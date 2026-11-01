import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { journeyView, journeyViewKey, type State, type Task } from "@petrina/core";
import { duration, type Lookup } from "../lib";
import { layoutJourney } from "../journeyLayout";
import { Controls, Diagram, JourneyEdge, JourneyList, type BoxData, type EdgeData } from "./journey/JourneyDiagram";
import { StepDetails } from "./journey/StepDetails";
import { askKind, askOutcome, footLine, spokenStep, startWords, targetOf, toolLine, useReducedMotion } from "./journey/journeyWords";

export { askOutcome, JourneyEdge, JourneyList, spokenStep, startWords };

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
  onSelectionChange?: (id?: string, attempt?: string) => void;
  selectedStep?: string;
  selectedAttempt?: string;
}

/** The task's journey as a live diagram, the same steps as a list, and the chosen step's details. */
export function Journey(props: JourneyProps) {
  return (
    <ReactFlowProvider>
      <JourneyBody {...props} />
    </ReactFlowProvider>
  );
}

function JourneyBody({ task, state, find, onPlan, onOpenTask, workspace = false, detailsTarget, onSelectionChange, selectedStep, selectedAttempt }: JourneyProps) {
  const profiles = useMemo(
    () => [
    ...(task.maintenance ? [task.maintenance.profile] : []),
    ...(task.direct ? [task.direct.profile] : []),
    ...state.profiles,
    ...(state.retiredProfiles ?? [])
  ],
    [
    state.profiles,
    state.retiredProfiles,
    task.maintenance?.profile,
    task.direct?.profile
  ]
  );
  const viewKey = journeyViewKey(
    task,
    {
    roles: state.roles,
    profiles,
    tasks: state.tasks,
    inbox: state.inbox,
    ...(state.planner ? { planner: state.planner } : {})
  }
  );
  const view = useMemo(
    () => journeyView(task, { roles: state.roles, profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) }),
    // A WebSocket update replaces every task object, including the long conversation history. Only
    // rebuild the diagram when one of the small set of fields that affects it actually changes.
    [viewKey],
  );
  const [localSelection, setSelected] = useState<string>();
  const [localAttempt, setAttempt] = useState<string>();
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
        const next = {
          width: el.clientWidth,
          rem,
          cap: workspace ? el.clientHeight : Math.round(Math.max(
          18 * rem,
          Math.min(
          28 * rem,
          window.innerHeight * 0.55
        )
        ))
        };
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
    return () => {
      mounted = false;
      fonts?.removeEventListener("loadingdone", changed);
    };
  }, []);

  const start = startWords(view, state.now);
  // Only a change to the journey's shape moves boxes: a new status line or a ticking clock does not.
  const shape = JSON.stringify([
    start,
    view.end?.text,
    view.rest,
    view.nodes.map((node) => [
    node.id,
    node.kind,
    node.state,
    node.run,
    node.tone,
    node.reason,
    node.asks.length,
    node.team?.length
  ])
  ]);
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
  }, [shape, space.width, space.rem, fontEpoch]);
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
    () => {
      const present = new Set(layout.items.map((item) => item.id));
      for (const id of cache.current.keys()) if (!present.has(id)) cache.current.delete(id);
      return layout.items.map((item) => {
        const node = byId.get(item.id);
        const data: BoxData = {
          kind: item.kind,
          ...(node ? { node } : {}),
          ...(node?.roleId && find.role(node.roleId) ? { role: find.role(node.roleId)! } : {}),
          ...(item.kind === "start" ? { text: start } : item.kind === "end" ? {
            text: view.end?.text ?? "",
            endState: view.end?.state ?? "done"
          } : item.kind === "rest" ? { text: view.rest ?? "" } : {}),
          ...(node && toolLine(node, find) ? { tool: toolLine(node, find)! } : {}),
          foot: node ? footLine(node, state.now, find) : "",
          asks: (node?.asks ?? []).map((ask) => ({
            id: ask.id,
            label: `${askKind(ask)} · ${duration(
            ask.at,
            ask.endedAt ?? state.now
          )}`,
            title: ask.title,
            outcome: askOutcome(ask),
            open: ask.endedAt === undefined
          })),
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
        const made: Node<BoxData> = {
          id: item.id,
          type: "journey",
          position: {
          x: item.x,
          y: item.y
        },
          data,
          width: item.width,
          height: item.height,
          draggable: false,
          selectable: false,
          connectable: false
        };
        cache.current.set(item.id, { key, node: made });
        return made;
      });
    },
    [layout, byId, find, start, view.end, view.rest, state.now, selectedId, focused],
  );
  const edges = useMemo(
    () =>
      layout.edges.map((edge): Edge<EdgeData> => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "journey",
        data: {
          path: edge.path,
          tipX: edge.tipX,
          tipY: edge.tipY,
          tip: Math.round(space.rem * 0.5),
          ...(edge.label ? { label: edge.label } : {}),
          labelX: edge.labelX,
          labelY: edge.labelY,
          labelWidth: edge.labelWidth,
          kind: edge.kind,
          labelTone: edge.labelTone,
          live: edge.live,
          motion: edge.live && !reduced
        },
        selectable: false,
        focusable: false,
      })),
    [layout, reduced, space.rem],
  );

  // Reading another step stops following the live one, and reading the live one stops it once it hands off,
  // so a handoff never moves the diagram away. Back to now resumes.
  const select = (id?: string, attempt?: string) => {
    const next = workspace && id === selected && !attempt ? undefined : id;
    setAttempt(attempt);
    if (!workspace) setSelected(next);
    onSelectionChange?.(next, attempt);
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
        <Diagram
          nodes={nodes}
          edges={edges}
          items={layout.items}
          contentHeight={layout.height}
          height={height}
          target={target}
          {...(focused || selected ? { focused: focused ?? selected } : {})}
          glide={glide}
          minZoom={minZoom}
          following={following}
          setFollowing={setFollowing}
          onSelect={select}
          scrollable={workspace}
        />
      </div>
      <p className="sr-only" aria-live="polite">
        {chosen ? `${chosen.name}: its details are ${workspace ? "in the right panel" : "below the diagram"}.` : ""}
      </p>
      {workspace ? detailsTarget && createPortal(
        chosen ? <StepDetails
        key={chosen.id}
        selectedAttempt={workspace ? selectedAttempt : localAttempt}
        onOriginal={select}
        node={chosen}
        task={task}
        state={state}
        find={find}
        now={state.now}
        onPlan={onPlan}
        {...(onOpenTask ? { onOpen: onOpenTask } : {})}
      /> : selected ? <p className="empty-state">This step is no longer available in this task's flow. Go back to the task or choose another step.</p> : null,
        detailsTarget
      ) : chosen ? (
        <StepDetails
          selectedAttempt={workspace ? selectedAttempt : localAttempt}
          onOriginal={select}
          node={chosen}
          task={task}
          state={state}
          find={find}
          now={state.now}
          onPlan={onPlan}
          onClose={() => setSelected(undefined)}
          {...(onOpenTask ? { onOpen: onOpenTask } : {})}
        />
      ) : (
        <p className="note journey-hint">Click a step to see its details here.</p>
      )}
    </section>
  );
}
