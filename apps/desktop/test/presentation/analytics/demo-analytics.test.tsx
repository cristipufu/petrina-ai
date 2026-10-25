

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemo, reviewStats, type AnalyticsUsage, type UsageRequest } from '@petrina/core';
import { AnalyticsPage } from '../../../src/components/Analytics';
import { lookup } from '../../../src/lib';

let simulator: Simulator;

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: { usage: (request: UsageRequest) => simulator.usage(request) } }));

let root: Root;

let host: HTMLDivElement;

function el<T extends HTMLElement = HTMLElement>(selector: string): T { const found = host.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }

function all(selector: string) { return [...host.querySelectorAll(selector)]; }

async function click(selector: string) { await act(async () => { el(selector).click(); }); }

async function pick(control: string, words: string) {
  const tab = all(`[aria-label="${control}"] button`).find((button) => button.textContent === words);
  expect(tab, `${control}: ${words}`).toBeDefined();
  await act(async () => { (tab as HTMLButtonElement).click(); });
}

async function show(options: { projected?: boolean; onOpen?: (id: string) => void } = {}) {
  const demo = createDemo(1_000_000_000);
  simulator = new Simulator({ ...demo.state, pool: { ...demo.state.pool, paused: true } }, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
  const full = simulator.getState();
  const state = options.projected ? { ...full, tasks: full.tasks.filter((task) => task.state !== 'done' && task.state !== 'cancelled'), history: { revision: 1, total: full.tasks.filter((task) => task.state === 'done' || task.state === 'cancelled').length, products: [], reviews: reviewStats([]), reviewsByProduct: {}, steps: [] } } : full;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AnalyticsPage state={state} find={lookup(state)} product="all" about={false} onAboutSeen={() => {}} onOpen={options.onOpen ?? (() => {})} />));
  // The numbers arrive after the first render.
  await act(async () => { await Promise.resolve(); });
}

afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Analytics charts', () => {
  it('opens archived task usage from a projected state while keeping removed product rows unavailable', async () => {
    const onOpen = vi.fn();
    await show({ projected: true, onOpen });
    await pick('Period', '30 days');
    const toggle = all('.splits-head button').find((button) => button.textContent === 'By task')!;
    await act(async () => (toggle as HTMLButtonElement).click());
    const split = all('.split').find((section) => section.querySelector('h3')?.textContent === 'By task')!;
    const more = split.querySelector<HTMLButtonElement>('.show-earlier');
    if (more) await act(async () => more.click());
    const full = simulator.getState();
    const archived = full.tasks.filter((task) => task.state === 'done' || task.state === 'cancelled');
    const usage = simulator.usage({ view: 'analytics', period: '30d' }) as AnalyticsUsage;
    const index = usage.byTask.findIndex((line) => line.note !== 'removed' && archived.some((task) => task.id === line.taskId));
    expect(index).toBeGreaterThanOrEqual(0);
    const button = split.querySelectorAll('.split-row:not(.head)')[index]!.querySelector<HTMLButtonElement>('button.split-open');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(usage.byTask[index]!.taskId);
    const removed = [...split.querySelectorAll('.split-row')].filter((row) => row.querySelector('.usage-note')?.textContent === 'removed');
    expect(removed.length).toBeGreaterThan(0);
    for (const row of removed) expect(row.querySelector('button.split-open')).toBeNull();
  });

  it('draws tokens over time as stacked bars with a legend, a running total and a table of the same numbers', async () => {
    await show();
    const figure = el('.analytics .chart-figure:has(.band, .hit)');
    expect([...figure.querySelectorAll('.legend span')].map((entry) => entry.textContent)).toEqual(['Claude Code', 'Codex']);
    expect(figure.querySelectorAll('svg rect.hit')).toHaveLength(7);
    expect(figure.querySelectorAll('svg path.series-line')).toHaveLength(1);
    expect(figure.textContent).toContain('Running total');
    expect(el('.chart-head.tokens').textContent).toContain('Tokens per day, by tool, with the running total');

    // The numbers show on keyboard focus, not only on hover.
    const bars = figure.querySelectorAll('svg rect.hit');
    await act(async () => { bars[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    const tip = el('[role="tooltip"]');
    expect(tip.textContent).toContain('Claude Code');
    expect(tip.textContent).toContain('Running total');

    await pick('Tokens as a chart or a table', 'Table');
    const table = el('table.chart-table');
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Day', 'Claude Code', 'Codex', 'Tokens', 'Running total']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(7);
    expect(host.querySelector('.analytics .chart-figure svg rect.hit')).toBeNull();
    await pick('Tokens as a chart or a table', 'Chart');
    expect(host.querySelectorAll('.analytics .chart-figure svg rect.hit')).toHaveLength(7);
  });

  it('switches the split to models and providers, and the measure to a part of the tokens or agent time', async () => {
    await show();
    await pick('How the chart is split', 'By model');
    const legend = () => [...el('.analytics .chart-figure:has(.hit) .legend').querySelectorAll('span')].map((entry) => entry.textContent);
    expect(legend()).toContain('Opus 5.5');
    expect(legend()).toContain('Sonnet 5.5');
    expect(el('.chart-head.tokens').textContent).toContain('by model');
    await pick('How the chart is split', 'By provider');
    expect(legend()).toEqual(['Anthropic', 'OpenAI']);
    expect([...all('[aria-label="What the chart shows"] button')].map((button) => button.textContent)).toEqual(['Tokens', 'New input', 'Reused input', 'Output', 'Agent time']);
    await pick('What the chart shows', 'Reused input');
    expect(el('.chart-head.tokens').textContent).toContain('Reused input per day, by provider');
    await pick('What the chart shows', 'Agent time');
    expect(el('.chart-head.tokens').textContent).toContain('Agent time per day, by provider');
    // A fixed colour follows each series whatever the measure.
    expect(all('.analytics .chart-figure:has(.hit) .legend i').map((swatch) => swatch.getAttribute('style'))).toEqual(['background: var(--provider-anthropic, var(--slate));', 'background: var(--provider-openai, var(--slate));']);
  });

  it('shows one allowance per tool with matching bounded summaries and keyboard details', async () => {
    await show();
    expect(all('.limit-history-card')).toHaveLength(2);
    expect(all('.limit-history-plot')).toHaveLength(2);
    expect(el('.limit-history-choice select').textContent).toContain('5-hour · All models');
    await act(async () => el('.limit-history-plot').focus());
    expect(el('[role="tooltip"]').textContent).toContain('Possible resets:');
    const description = el('[role="tooltip"]').textContent;
    await pick('Usage history as a chart or a table', 'Table');
    expect(all('.limit-history-card tbody tr')).toHaveLength(14);
    expect(el('.limit-history-table').textContent).toContain('Highest reported');
    expect(description).toContain(el('.limit-history-table tbody tr td').textContent);
    await act(async () => el<HTMLButtonElement>('.limit-history-table tbody button').click());
    expect(el('.limit-history-readings-view').textContent).toContain('Reported reset');
    expect(all('.limit-history-readings-view tbody tr').length).toBeLessThanOrEqual(20);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(el('.limit-history-table tbody button')).toBe(document.activeElement);
  });

  it('charts the hours of today when the period is Today', async () => {
    await show();
    await click('[aria-label="Period"] button:first-child');
    await act(async () => { await Promise.resolve(); });
    expect(el('.chart-head.tokens').textContent).toContain('per hour, today');
    expect(el('.analytics .chart-figure:has(.hit)').querySelectorAll('svg rect.hit')).toHaveLength(24);
    expect(all(".limit-history-card .limit-history-slot")).toHaveLength(48);
    expect(host.querySelector(".limit-history-card .reset")).toBeNull();
  });
});

describe('the Analytics page after review', () => {
  it('separates security findings into outcome columns and follows product scope', async () => {
    await show();
    const state = structuredClone(simulator.getState());
    for (const task of state.tasks) task.findings = [];
    const task = state.tasks.find((task) => task.productId === 'shop' && task.state !== 'cancelled')!;
    task.findings = [
      { id: 'code', text: 'Code issue', severity: 'blocking', raisedBy: state.profiles[0]!.id, confirmedBy: [], status: 'fixed' },
      { id: 'security', text: 'Security issue', severity: 'blocking', roleId: 'security-reviewer', raisedBy: state.profiles[0]!.id, confirmedBy: [], status: 'dismissed', verification: { by: state.profiles[0]!.id, verdict: 'not-a-bug', reason: 'Verified', at: state.now }, votes: state.profiles.filter((profile) => profile.toolId === 'codex' || profile.toolId === 'claude-code').slice(0, 2).map((profile) => ({ by: profile.id, toolId: profile.toolId, verdict: 'not-a-bug', reason: 'Verified' })) },
    ];
    const render = async (product: string) => act(async () => root.render(<AnalyticsPage state={state} find={lookup(state)} product={product} about={false} onAboutSeen={() => {}} onOpen={() => {}} />));
    await render('all');
    const table = el('table[aria-label="Findings by review role"]');
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Review role', 'Findings', 'Important', 'Fixed', 'Not a bug', 'Could not verify', 'Downgraded', 'Kept', 'Still open']);
    const security = [...table.querySelectorAll('tbody tr')].find((row) => row.textContent?.startsWith('Security reviewer'))!;
    expect([...security.children].map((cell) => cell.textContent)).toEqual(['Security reviewer', '1', '1', '0', '1', '0', '0', '0', '0']);
    expect([...table.querySelectorAll('tfoot tr > *')].map((cell) => cell.textContent)).toEqual(['All reviewers', '2', '2', '1', '1', '0', '0', '0', '0']);
    expect(all('.splits > .split > h3').map((heading) => heading.textContent)).toEqual(['By role', 'By tool', 'By model']);
    expect(el('[aria-labelledby="verifier-impact"] .review-impact').textContent).toContain('1 of 1 completed checks (100%)');
    expect([...el('table[aria-label="Verifier outcomes"]').querySelectorAll('tfoot tr > *')].map((cell) => cell.textContent)).toEqual(['All checks', '1', '0', '1', '0', '0', '0']);
    expect(el('table[aria-label="Votes by verifier"]').textContent).toContain('100%');
    await render('notes');
    expect([...el('table[aria-label="Findings by review role"]').querySelectorAll('tbody td')].every((cell) => cell.textContent === '0')).toBe(true);
    expect(el('[aria-labelledby="analytics-reviews"]').textContent).toContain('Notes · all recorded reviews, across all dates');
  });

  async function rerender(product: string) {
    const state = simulator.getState();
    await act(async () => root.render(<AnalyticsPage state={state} find={lookup(state)} product={product} about={false} onAboutSeen={() => {}} onOpen={() => {}} />));
    await act(async () => { await Promise.resolve(); });
  }

  it('keeps its period, split and table choices and changes its scope when the product changes', async () => {
    await show();
    await click('[aria-label="Period"] button:first-child');
    await pick('How the chart is split', 'By model');
    await pick('Tokens as a chart or a table', 'Table');
    await rerender('shop');
    expect(el('h1').textContent).toBe('Analytics');
    expect(el('.page-head p').textContent).toContain('Shop · what the squad used today');
    expect(el('[aria-label="Period"] button[aria-selected="true"]').textContent).toBe('Today');
    expect(el('[aria-label="How the chart is split"] button[aria-selected="true"]').textContent).toBe('By model');
    expect(el('[aria-label="Tokens as a chart or a table"] button[aria-selected="true"]').textContent).toBe('Table');
    expect(el('table.chart-table thead th').textContent).toBe('Hour');
    await rerender('all');
    expect(el('.page-head p').textContent).toContain('All products · what the squad used today');
    expect(el('[aria-label="How the chart is split"] button[aria-selected="true"]').textContent).toBe('By model');
  });

  it('never shows a missing model figure as a dash: it reads "not reported", with details on too', async () => {
    await show();
    expect(all('.stat, .split-row').map((entry) => entry.textContent).join('')).not.toMatch(/[—–]/);
    await click('label.toggle input');
    expect(el<HTMLInputElement>('label.toggle input').checked).toBe(true);
    const cells = all('.split-row:not(.head) [role="cell"]').map((cell) => cell.textContent ?? '');
    expect(cells.some((text) => text === 'not reported')).toBe(true);
    expect(all('.stat, .split-row').map((entry) => entry.textContent).join('')).not.toMatch(/[—–]/);
  });
});
