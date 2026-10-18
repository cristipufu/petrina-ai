import { act, useSyncExternalStore } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Window as HappyWindow } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState, createPortfolioDemo, journeyView, JOURNEY_WORDS, type JourneyView, type State, type Task } from '@petrina/core';
import { App } from '../src/App';
import { JourneyEdge, JourneyList, spokenStep } from '../src/components/Journey';
import { layoutJourney } from '../src/journeyLayout';
import { deliveryText, lookup } from '../src/lib';

let simulator: Simulator;
const live = { link: 'live', desktop: false };
const empty: never[] = [];
vi.mock('../src/engine', () => ({
  mode: 'demo', desktop: false,
  startClock: () => () => {},
  useEngineStatus: () => live,
  useUnsent: () => empty,
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === 'synced' ? () => true : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

const NOW = 1_000_000_000_000;
let root: Root;
let host: HTMLDivElement;
const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });
const taskOf = (state: State, id: string): Task => state.tasks.find((task) => task.id === id)!;
async function key(name: string) { await act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); }); }
async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

beforeEach(() => localStorage.clear());
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the journey as a list, for screen readers and the keyboard', () => {
  const state = createDemoState(NOW);
  const view = journeyView(taskOf(state, 'pricing-refresh'), contextOf(state));
  const find = lookup(state);

  it('reads each step: number, name, state, tool and model, time, outcome and why it moved on', async () => {
    const selected: string[] = [];
    await render(<JourneyList view={view} find={find} now={state.now} onFocusStep={() => {}} onSelect={(id) => selected.push(id)} />);
    const list = host.querySelector('ol')!;
    expect(list.getAttribute('aria-label')).toBe(`Journey, ${view.nodes.length} steps`);
    const items = [...list.querySelectorAll('li')].map((item) => item.textContent);
    expect(items[3]).toBe('4. Code reviewer. Done. Codex · sol · high effort. 3m elapsed. 1 important. Moved on: sent back: 1 important.');
    expect(items[7]).toMatch(/^8\. Your delivery check\. Waiting for you\. Waiting \d+m so far\. Reviews done/);
    expect(items[8]).toBe('9. Publish delivery. Next.');
  });

  it('is one tab stop on the live step; the arrow keys move through it and Enter opens a step', async () => {
    const selected: string[] = [];
    const focused: (string | undefined)[] = [];
    await render(<JourneyList view={view} find={find} now={state.now} onFocusStep={(id) => focused.push(id)} onSelect={(id) => selected.push(id)} />);
    const items = [...host.querySelectorAll('li')];
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[7]]);
    expect(items[7]!.getAttribute('aria-current')).toBe('step');
    await act(async () => items[7]!.focus());
    await key('ArrowUp');
    expect(document.activeElement).toBe(items[6]);
    await key('Home');
    expect(document.activeElement).toBe(items[0]);
    await key('End');
    expect(document.activeElement).toBe(items.at(-1));
    await key('ArrowLeft');
    await key('Enter');
    expect(selected).toEqual([view.nodes[7]!.id]);
    expect(focused.at(-1)).toBe(view.nodes[7]!.id);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('says what a question or permission asked, and how you answered', () => {
    const asking = journeyView(taskOf(state, 'guest-checkout'), contextOf(state));
    const builder = asking.nodes.findIndex((node) => node.name === 'Builder');
    expect(spokenStep(asking.nodes[builder]!, builder, find, state.now)).toMatch(/Builder\. Waiting for you\. Codex · sol · high effort\. \d+m elapsed so far\. Waiting for your permission\. Permission: Add a new package: Stripe\.js\. Waiting for you\.$/);
  });
});

describe('the journey in the task sheet', () => {
  async function mount(state: State) {
    simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
    await render(<App />);
  }
  async function openTask(id: string) {
    await act(async () => host.querySelector<HTMLElement>(`.card-open[aria-describedby="status-${id}"]`)!.click());
  }

  it('opens first in the Overview, and Enter on a step shows its details and its part of the timeline', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    expect(host.querySelector('.workspace-journey h2')?.textContent).toContain('Task flow');
    expect(host.querySelector('.task-list')).not.toBeNull();
    expect(host.querySelector('.task-detail-panel #journey-details-title')).toBeNull();
    const reviewer = [...host.querySelectorAll<HTMLElement>('.journey-list li')].find((item) => item.textContent?.startsWith('4. Code reviewer'))!;
    await act(async () => reviewer.focus());
    await key('Enter');
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Code reviewer');
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('sent back: 1 important');
    expect([...details.querySelectorAll('.tl .text')].map((entry) => entry.textContent)).toContain('Sent back to the builder: 1 important');

    // The selected run's conversation is read inline, without changing the task tab.
    expect(details.querySelector('.step-conversation')?.textContent).toContain('Conversation');
    expect(host.querySelector('.step-panel-bar')?.textContent).toContain('Step details');
    expect([...details.querySelectorAll('button')].some((button) => button.textContent?.includes('Read this step'))).toBe(false);
  });

  it('stops following the live step while you read another one, until Back to now', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    const backToNow = () => [...host.querySelectorAll<HTMLButtonElement>('.journey-controls button')].find((button) => button.textContent === 'Back to now');
    expect(backToNow()).toBeUndefined();
    // Choosing the live step keeps following it.
    const items = () => [...host.querySelectorAll<HTMLElement>('.journey-list li')];
    await act(async () => items()[7]!.focus());
    await key('Enter');
    expect(backToNow()).toBeUndefined();
    // Moving to an earlier step, by keyboard or click, stops following.
    await key('ArrowUp');
    expect(backToNow()).toBeDefined();
    await act(async () => backToNow()!.click());
    expect(backToNow()).toBeUndefined();
    await act(async () => items()[1]!.click());
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Builder');
    expect(backToNow()).toBeDefined();
    // A handoff while you read keeps the diagram where it is: still not following.
    await act(async () => { simulator.setPoolPaused(false); simulator.tick(); simulator.tick(); });
    expect(backToNow()).toBeDefined();
  });

  it('keeps the flow visible across detail tabs and switches tasks from the adjacent list', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    const workspace = host.querySelector('.task-workspace');
    const canvas = host.querySelector('.journey-canvas');
    await act(async () => host.querySelector<HTMLElement>('#tab-plan')!.click());
    expect(host.querySelector('.journey-canvas')).toBe(canvas);
    expect(host.querySelector('.task-detail-panel')?.textContent).toContain('Why this plan');
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][1]!.click());
    expect(host.querySelector('.task-global-details')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('.task-detail-panel #journey-details-title')?.textContent).toContain('Builder');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.step-panel-bar button')][0]!.click());
    expect(host.querySelector('#tab-plan')?.getAttribute('aria-selected')).toBe('true');
    const other = [...host.querySelectorAll<HTMLButtonElement>('.task-list-item')].find((button) => button.textContent?.includes('Guest checkout'))!;
    await act(async () => other.click());
    expect(host.querySelector('.task-workspace')).toBe(workspace);
    expect(host.querySelector('.sheet-title')?.textContent).toBe('Guest checkout');
    expect(host.querySelector('.task-detail-panel #journey-details-title')).toBeNull();
    expect(host.querySelector('.task-list-item[aria-current="true"]')?.textContent).toContain('Guest checkout');
    // The current permission can be answered without closing the task or finding it in the inbox.
    const allow = [...host.querySelectorAll<HTMLButtonElement>('.task-decisions button')].find((button) => button.textContent === 'Allow')!;
    await act(async () => allow.click());
    expect(simulator.getState().inbox.some((item) => item.taskId === 'guest-checkout' && item.kind === 'permission')).toBe(false);
    expect(host.querySelector('.task-workspace')).toBe(workspace);
    const ids = [...host.querySelectorAll<HTMLElement>('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops following when the live step you are reading hands off', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    const backToNow = () => [...host.querySelectorAll<HTMLButtonElement>('.journey-controls button')].find((button) => button.textContent === 'Back to now');
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][7]!.click());
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Your delivery check');
    expect(backToNow()).toBeUndefined();
    // You approve the delivery elsewhere while its details are open: the diagram stays with the step you read.
    const check = simulator.getState().inbox.find((item) => item.taskId === 'pricing-refresh' && item.kind === 'delivery')!;
    await act(async () => simulator.approve(check.id));
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Your delivery check');
    expect(backToNow()).toBeDefined();
    await act(async () => backToNow()!.click());
    expect(backToNow()).toBeUndefined();
  });

  it('keeps reading a step in place when the hidden Session receives a message', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    await act(async () => host.querySelector<HTMLElement>('#tab-session')!.click());
    const scroller = host.querySelector<HTMLElement>('.task-detail-panel .sheet-scroll')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 900, configurable: true });
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][1]!.click());
    scroller.scrollTop = 45;
    await act(async () => simulator.sendMessage('pricing-refresh', 'A new note while I read this step'));
    expect(scroller.scrollTop).toBe(45);
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Builder');
  });

  it('offers zoom, the whole journey, and labels every control', async () => {
    await mount(createPortfolioDemo(NOW).state);
    const usage = simulator.getState().tasks.find((task) => task.title === 'Usage dashboard' && task.state === 'done')!;
    await act(async () => host.querySelector<HTMLElement>('button.fold')!.click());
    await act(async () => host.querySelector<HTMLElement>(`.done-row[data-task-id="${usage.id}"]`)!.click());
    const controls = [...host.querySelectorAll('.journey-controls button')].map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(controls).toEqual(['Zoom in', 'Zoom out', 'Show the whole journey']);
    expect(host.querySelector('.journey-list')?.getAttribute('aria-label')).toBe('Journey, 20 steps');
    expect(host.querySelector('.journey-flow')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('unusual endings in words', () => {
  const state = createDemoState(NOW);
  const merged = taskOf(state, 'sentry');
  it('a closed pull request is not awaiting merge, and Mark as done delivers nothing', () => {
    expect(deliveryText(merged)).toEqual({ text: `Pull request #${merged.pr!.number} merged`, done: true });
    for (const prState of [undefined, 'open'] as const) {
      // Older saved records may predate the required pull-request state.
      const pr = { ...merged.pr!, state: prState } as NonNullable<Task['pr']>;
      expect(deliveryText({ ...merged, state: 'done', pr })).toEqual({ text: `Pull request #${pr.number} closed without merging`, done: false });
      expect(deliveryText({ ...merged, state: 'pr-open', pr })).toEqual({ text: `Pull request #${pr.number} · awaiting merge`, done: false });
    }
    expect(deliveryText({ ...merged, pr: { ...merged.pr!, state: 'closed' } })).toEqual({ text: `Pull request #${merged.pr!.number} closed without merging`, done: false });
    expect(deliveryText({ ...merged, state: 'cancelled', pr: { ...merged.pr!, state: 'closed' } })).toEqual({ text: `Pull request #${merged.pr!.number} closed without merging`, done: false });
    const { pr: _none, ...marked } = merged;
    expect(deliveryText(marked)).toEqual({ text: 'Marked as done · delivery not confirmed', done: false });
  });
});

describe('the journey layout', () => {
  const state = createPortfolioDemo(NOW).state;
  const usage = journeyView(state.tasks.find((task) => task.title === 'Usage dashboard' && task.state === 'done')!, contextOf(state));

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

describe('the live arrow with reduced motion', () => {
  it.each(['back', 'stuck', 'on'] as const)('stays solid and stronger after %s, keeping its colour', async (tone) => {
    const device = (window as unknown as HappyWindow).happyDOM.settings.device;
    const previous = device.prefersReducedMotion;
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    device.prefersReducedMotion = 'reduce';
    document.head.append(style);
    try {
      const view: JourneyView = {
        start: { kind: 'started', at: NOW },
        nodes: [
          { id: 'from', name: 'Code reviewer', kind: 'agent', state: 'done', tone, asks: [] },
          { id: 'to', name: 'Builder (fixes)', kind: 'agent', state: 'now', run: 'working', tone: 'on', asks: [] },
        ],
      };
      const edge = (run: 'working' | 'paused' | 'waiting', finished = false) => {
        view.nodes[1] = { ...view.nodes[1]!, state: finished ? 'done' : 'now', run };
        const arrow = layoutJourney(view, 820, 16, 'Started').edges.find((entry) => entry.source === 'from')!;
        return <JourneyEdge data={{ ...arrow, tip: 8, motion: arrow.live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches }} />;
      };
      await render(<svg>{edge('working')}</svg>);
      const live = getComputedStyle(host.querySelector('.je-line')!);
      const width = Number.parseFloat(live.strokeWidth);
      const colour = live.stroke;
      expect(width).toBeGreaterThan(2);
      expect(live.strokeDasharray).toBe('none');
      expect(live.animation).toBe('none');
      // Finished send-backs, paused steps and waiting for a slot must not get live emphasis.
      for (const [run, finished] of [['working', true], ['paused', false], ['waiting', false]] as const) {
        await act(async () => root.render(<svg>{edge(run, finished)}</svg>));
        const resting = getComputedStyle(host.querySelector('.je-line')!);
        expect(Number.parseFloat(resting.strokeWidth)).toBeLessThan(width);
        if (tone !== 'on') expect(resting.stroke).toBe(colour);
      }
    } finally {
      style.remove();
      device.prefersReducedMotion = previous;
    }
  });
});
