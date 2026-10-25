// @vitest-environment node
import { describe, expect, it } from "vitest";
import { JOURNEY_WORDS, type JourneyView } from "@petrina/core";
import { layoutJourney } from '../../../src/journeyLayout';

const NOW = 1_000_000_000_000;

describe('the journey layout', () => {
// A representative long flow with agent, command and decision boxes; no generated demo workflow.
  const usage: JourneyView = { start: { kind: 'started', at: NOW - 60_000 },
  nodes: Array.from({ length: 24 }, (_, index) => ({ id: 'step-' + index, name: ['Builder', 'Automated checks', 'Your delivery check'][index % 3]!, kind: index % 3 === 2 ? 'you' : index % 3 === 1 ? 'petrina' : 'agent', state: 'done', tone: 'on', asks: [] })),
  end: { text: 'Delivered', state: 'done' },
};

  it.each(['back', 'stuck'] as const)('keeps a %s arrow’s colour when its target starts working or waits', (tone) => {
    for (const target of [
      { state: 'now', run: 'working' },
      { state: 'now', run: 'paused' },
      { state: 'now', run: 'waiting' },
      { state: 'you' },
      { state: 'done' },
    ] as const) {
      const view: JourneyView = {
        start: { kind: 'started', at: NOW },
        nodes: [
          { id: 'from', name: 'Builder', kind: 'agent', state: tone === 'stuck' ? 'failed' : 'done', tone, asks: [], reason: tone === 'stuck' ? 'stuck' : 'changes asked' },
          { id: 'to', name: 'Next step', kind: target.state === 'you' ? 'you' : 'agent', tone: 'on', asks: [], ...target },
        ],
      };
      const arrow = layoutJourney(view, 820, 16, 'Started').edges.find((edge) => edge.source === 'from')!;
      expect(arrow.kind).toBe(tone);
      expect(arrow.labelTone).toBe(tone);
      expect(arrow.live).toBe(target.state === 'now' && target.run === 'working');
    }
  });

  it('wraps rows like text, down to one box per row, with the arrow running back under each row', () => {
    for (const width of [2000, 820, 560, 260]) {
      const layout = layoutJourney(usage, width, 16, 'Started 22h ago');
      const rows = new Map<number, typeof layout.items>();
      for (const item of layout.items) rows.set(item.row, [...(rows.get(item.row) ?? []), item]);
      for (const items of rows.values()) {
        // Nothing in a row overlaps, and everything fits in the width.
        items.slice(1).forEach((item, index) => expect(item.x).toBeGreaterThanOrEqual(items[index]!.x + items[index]!.width));
        expect(items.at(-1)!.x + items.at(-1)!.width).toBeLessThanOrEqual(Math.max(width, 24 + 192));
      }
      if (width <= 260) expect([...rows.values()].every((items) => items.length === 1)).toBe(true);
      for (const edge of layout.edges.filter((entry) => entry.wraps)) {
        // The arrow between rows runs below everything in the row it leaves.
        const from = layout.items.find((item) => item.id === edge.source)!;
        const bottom = Math.max(...rows.get(from.row)!.map((item) => item.y + item.height));
        expect(edge.labelY).toBeGreaterThan(bottom);
      }
    }
  });

  it('reserves the full arrow explanation beside boxes and below wrapped rows', () => {
    const reason = [
      JOURNEY_WORDS.landed(['Guest checkout with receipts and saved payment methods for returning customers', 'Account settings with workspace invitations and a complete billing history', 'An accessible reporting dashboard with monthly exports and timezone support']),
      JOURNEY_WORDS.othersCancelled(['Order confirmation emails with delivery tracking for international customers']),
    ].join('; ');
    const view: JourneyView = {
      start: { kind: 'started', at: NOW - 60_000 },
      nodes: [
        { id: 'wait', name: 'Waiting for others', kind: 'wait', state: 'done', tone: 'on', asks: [], reason },
        { id: 'planner', name: 'Planner', kind: 'agent', state: 'now', tone: 'on', asks: [] },
      ],
    };
    for (const [width, rem] of [[2000, 16], [820, 16], [560, 16], [260, 16], [820, 32]] as const) {
      const layout = layoutJourney(view, width, rem, 'Started');
      const label = layout.edges.find((edge) => edge.source === 'wait')!;
      const bottom = label.labelY;
      const top = bottom - label.labelHeight;
      expect(label.label).toBe(reason);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(layout.height);
      expect(label.labelX - label.labelWidth / 2).toBeGreaterThanOrEqual(0);
      expect(label.labelX + label.labelWidth / 2).toBeLessThanOrEqual(layout.width);
      for (const box of layout.items) {
        const overlaps = label.labelX - label.labelWidth / 2 < box.x + box.width && label.labelX + label.labelWidth / 2 > box.x && top < box.y + box.height && bottom > box.y;
        expect(overlaps, `label crosses ${box.id} at ${width}px / ${rem}px text`).toBe(false);
      }
    }
  });

  it('grows with enlarged text, so fewer boxes fit on a row', () => {
    const normal = layoutJourney(usage, 820, 16, 'Started');
    const large = layoutJourney(usage, 820, 32, 'Started');
    const perRow = (layout: typeof normal) => Math.max(...[...new Set(layout.items.map((item) => item.row))].map((row) => layout.items.filter((item) => item.row === row).length));
    expect(perRow(large)).toBeLessThan(perRow(normal));
  });
});
