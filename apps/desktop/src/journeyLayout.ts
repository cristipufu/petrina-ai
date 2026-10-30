// Where the journey's boxes sit: left to right, wrapping onto new rows like text. Sizes are in rem,
// so enlarged text makes the boxes bigger and the rows shorter, down to one box per row. Pure, so the
// diagram only moves when the journey or the space for it changes.

import type { JourneyNode, JourneyView } from "@petrina/core";

/** Full failure diagnostics belong in the details; keep the connecting arrow compact. */
const reasonLabel = (node?: JourneyNode) => node?.state === "failed" ? "stuck" : node?.reason;

/** Sizes in rem. Boxes are the same height so a row's arrows run straight. */
export const SIZES = {
  box: { w: 12, h: 8.25 },
  you: { w: 12, h: 7.25 },
  start: { w: 10, h: 2.5 },
  end: { w: 12, h: 3.5 },
  ask: { w: 11, h: 4, gap: 0.5, drop: 0.75 },
  /** Between boxes: wide enough for the words on an arrow, narrower when it has none. */
  gap: 5.5,
  gapQuiet: 2.5,
  /** Between rows: room for the arrow that runs back under a row, and its words. */
  rowGap: 3.5,
  padX: 1.5,
  padY: 1.25,
} as const;

export type ItemKind = "start" | "box" | "you" | "end" | "rest";

export interface LaidItem {
  id: string;
  kind: ItemKind;
  node?: JourneyNode;
  /** Top-left of the item, its asks included, in px. */
  x: number;
  y: number;
  width: number;
  /** The box itself, without the asks hanging under it. */
  bodyHeight: number;
  height: number;
  /** Where arrows meet it, from its top. */
  spine: number;
  row: number;
}

export type EdgeKind = "done" | "back" | "stuck" | "live" | "you" | "ahead" | "paused";

export interface LaidEdge {
  id: string;
  source: string;
  target: string;
  path: string;
  /** The arrowhead's tip: arrows always arrive from the left. */
  tipX: number;
  tipY: number;
  label?: string;
  labelX: number;
  labelY: number;
  /** The widest the words may be. */
  labelWidth: number;
  /** Full text height, reserved above an inline arrow or between wrapped rows. */
  labelHeight: number;
  kind: EdgeKind;
  /** The next step is working, even when a warning gives the arrow its colour. */
  live: boolean;
  /** The words keep the colour of why the work moved: amber for a send-back, red for stuck. */
  labelTone: "on" | "back" | "stuck" | "you";
  /** Runs from the end of one row back under it to the start of the next. */
  wraps: boolean;
}

export interface Layout {
  items: LaidItem[];
  edges: LaidEdge[];
  width: number;
  height: number;
}

function kindOf(node: JourneyNode): ItemKind {
  return node.kind === "you" ? "you" : "box";
}

/** Warning colours keep the reason visible; live movement is recorded separately. */
function edgeKind(from: JourneyNode | undefined, to: JourneyNode | undefined): EdgeKind {
  if (!to || to.state === "next" || to.state === "ahead") return "ahead";
  if (from?.tone === "stuck") return "stuck";
  if (from?.tone === "back") return "back";
  if (to.state === "you") return "you";
  if (to.state === "now") return to.run === "working" ? "live" : "paused";
  return "done";
}

/** A path through points with rounded corners. */
function rounded(points: readonly [number, number][], radius: number): string {
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [px, py] = points[index - 1]!;
    const [x, y] = points[index]!;
    const [nx, ny] = points[index + 1]!;
    const into = Math.min(radius, Math.hypot(x - px, y - py) / 2);
    const out = Math.min(radius, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - (Math.sign(x - px) * into);
    const ay = y - (Math.sign(y - py) * into);
    const bx = x + (Math.sign(nx - x) * out);
    const by = y + (Math.sign(ny - y) * out);
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  const [lx, ly] = points.at(-1)!;
  return `${d} L ${lx} ${ly}`;
}

/** The full label's dimensions at this maximum width, using the labels' own typography. */
export type MeasureLabel = (text: string, maxWidth: number) => { width: number; height: number };

/**
 * Lay the journey out in `width` px, with `rem` px to the rem. The start point comes first, then each
 * box, then the end point or, while the plan is not written yet, a note that the planner chooses the rest.
 */
export function layoutJourney(view: JourneyView, width: number, rem: number, startText: string, measured?: MeasureLabel): Layout {
  // Callers without browser layout use a character grid. The screen supplies the real font's dimensions.
  const measure: MeasureLabel = measured ?? ((text, maxWidth) => {
    const natural = Array.from(text).length * rem * 0.75 + 4;
    return { width: Math.min(natural, maxWidth), height: Math.ceil(natural / Math.max(1, maxWidth)) * rem + 2 };
  });
  const px = (value: number) => Math.round(value * rem);
  const entries: { id: string; kind: ItemKind; node?: JourneyNode; text?: string }[] = [
    { id: "start", kind: "start", text: startText },
    ...view.nodes.map((node) => ({ id: node.id, kind: kindOf(node), node })),
    ...(view.end ? [{ id: "end", kind: "end" as const, text: view.end.text }] : view.rest ? [{ id: "rest", kind: "rest" as const, text: view.rest }] : []),
  ];
  const size = (entry: typeof entries[number]) => {
    const body = entry.kind === "box" ? SIZES.box : entry.kind === "you" ? SIZES.you : entry.kind === "start" ? SIZES.start : SIZES.end;
    // Each reviewer or voter gets a readable tool-and-model line in the shared box.
    return { w: body.w, h: body.h + (entry.node?.kind === "agent" ? Math.max(0, (entry.node.team?.length ?? 1) - 1) : 0) + (entry.node?.waitReason ? 1 : 0) };
  };
  const asksBelow = (node?: JourneyNode) => (node?.asks.length ? px(SIZES.ask.drop) + node.asks.length * px(SIZES.ask.h) + (node.asks.length - 1) * px(SIZES.ask.gap) : 0);
  const left = px(SIZES.padX);
  const right = Math.max(width - px(SIZES.padX), left + px(SIZES.box.w));

  // Rows like text: an item goes on the current row if it fits, after the gap its arrow needs.
  const rows: { start: number; end: number }[] = [];
  const placed: { x: number; row: number }[] = [];
  let x = left;
  entries.forEach((entry, index) => {
    const w = px(size(entry).w);
    const label = reasonLabel(entries[index - 1]?.node);
    const gap = label ? Math.max(px(SIZES.gap), Math.ceil(measure(label, px(12)).width) + px(0.5)) : px(SIZES.gapQuiet);
    if (index === 0) {
      rows.push({ start: 0, end: 0 });
      placed.push({ x, row: 0 });
      x += w;
      return;
    }
    if (x + gap + w > right) {
      rows.push({ start: index, end: index });
      x = left;
    } else {
      x += gap;
      rows.at(-1)!.end = index;
    }
    placed.push({ x, row: rows.length - 1 });
    x += w;
  });

  // Measure each label at the width it will actually have. Wrapped arrows may use the empty end of
  // their row, so a message naming several prerequisites need not squeeze between two small boxes.
  const connections = entries.slice(1).map((_entry, index) => {
    const from = entries[index]!;
    const a = placed[index]!;
    const b = placed[index + 1]!;
    const x1 = a.x + px(size(from).w);
    const x2 = b.x;
    const label = reasonLabel(from.node);
    const wraps = a.row !== b.row;
    const back = x2 - px(1);
    const out = wraps ? Math.max(x1 + px(1), back + (label ? measure(label, right - left).width : 0) + px(2)) : x2;
    const labelWidth = wraps ? Math.max(px(6), out - back - px(2)) : x2 - x1 - px(0.5);
    return { labelWidth, labelHeight: label ? Math.ceil(measure(label, labelWidth).height) : 0, out, back, wraps, row: a.row };
  });

  // Each row is as tall as its tallest box plus what hangs under it; the boxes share one spine.
  const items: LaidItem[] = [];
  let top = px(SIZES.padY);
  const rowBottoms: number[] = [];
  rows.forEach((row, rowIndex) => {
    const members = entries.slice(row.start, row.end + 1);
    const inlineHeights = connections.filter((edge) => edge.row === rowIndex && !edge.wraps).map((edge) => edge.labelHeight + px(0.375));
    const above = Math.max(...members.map((entry) => px(size(entry).h) / 2), ...inlineHeights);
    const below = Math.max(...members.map((entry) => px(size(entry).h) / 2 + asksBelow(entry.node)));
    const spineY = top + above;
    members.forEach((entry, offset) => {
      const index = row.start + offset;
      const body = px(size(entry).h);
      const extra = asksBelow(entry.node);
      items.push({
        id: entry.id,
        kind: entry.kind,
        ...(entry.node ? { node: entry.node } : {}),
        x: placed[index]!.x,
        y: Math.round(spineY - body / 2),
        width: px(size(entry).w),
        bodyHeight: body,
        height: body + extra,
        spine: Math.round(body / 2),
        row: rowIndex,
      });
    });
    rowBottoms.push(spineY + below);
    const wrapped = connections.find((edge) => edge.row === rowIndex && edge.wraps);
    top = spineY + below + Math.max(px(SIZES.rowGap), (wrapped?.labelHeight ?? 0) + px(1.5));
  });

  const edges: LaidEdge[] = [];
  const radius = px(0.5);
  for (let index = 1; index < items.length; index += 1) {
    const from = items[index - 1]!;
    const to = items[index]!;
    const fromNode = from.node;
    const toNode = to.node;
    const x1 = from.x + from.width;
    const y1 = from.y + from.spine;
    const x2 = to.x;
    const y2 = to.y + to.spine;
    const kind: EdgeKind = to.kind === "end" ? (fromNode?.tone === "back" ? "back" : "done") : to.kind === "rest" ? "ahead" : edgeKind(fromNode, toNode);
    const live = toNode?.state === "now" && toNode.run === "working";
    const label = reasonLabel(fromNode);
    const labelTone = fromNode?.tone === "back" || fromNode?.tone === "stuck" ? fromNode.tone : kind === "you" ? "you" : "on";
    const tip = px(0.5);
    const { labelWidth, labelHeight, out, back } = connections[index - 1]!;
    if (from.row === to.row) {
      edges.push({
        id: `${from.id}->${to.id}`,
        source: from.id,
        target: to.id,
        path: `M ${x1} ${y1} L ${x2 - tip} ${y2}`,
        tipX: x2,
        tipY: y2,
        ...(label ? { label } : {}),
        labelX: (x1 + x2) / 2,
        labelY: y1 - px(0.375),
        labelWidth,
        labelHeight,
        kind,
        live,
        labelTone,
        wraps: false
      });
    } else {
      // Down from the end of the row, back under it (below anything hanging there), and into the next row's first box.
      const under = rowBottoms[from.row]! + Math.max(px(SIZES.rowGap) / 2, labelHeight + px(0.75));
      const path = rounded([[x1, y1], [out, y1], [out, under], [back, under], [back, y2], [x2 - tip, y2]], radius);
      edges.push({
        id: `${from.id}->${to.id}`,
        source: from.id,
        target: to.id,
        path,
        tipX: x2,
        tipY: y2,
        ...(label ? { label } : {}),
        labelX: (out + back) / 2,
        labelY: under - px(0.25),
        labelWidth,
        labelHeight,
        kind,
        live,
        labelTone,
        wraps: true
      });
    }
  }

  const height = (rowBottoms.at(-1) ?? 0) + px(SIZES.padY);
  return { items, edges, width: right + px(SIZES.padX), height: Math.round(height) };
}
