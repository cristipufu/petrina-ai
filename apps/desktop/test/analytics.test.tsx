import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemo, type UsageRequest } from '@petrina/core';
import { AnalyticsPage } from '../src/components/Analytics';
import { BarsOverTime, LinesOverTime, type BarPoint } from '../src/components/Charts';
import { FigureText } from '../src/components/Usage';
import { lookup } from '../src/lib';

// The page asks the squad for its numbers through the engine bridge; here the demo squad answers.
let simulator: Simulator;
vi.mock('../src/engine', () => ({ mode: 'demo', desktop: false, sim: { usage: (request: UsageRequest) => simulator.usage(request) } }));

let root: Root;
let host: HTMLDivElement;
function el<T extends HTMLElement = HTMLElement>(selector: string): T { const found = host.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }
function all(selector: string) { return [...host.querySelectorAll(selector)]; }
async function click(selector: string) { await act(async () => { el(selector).click(); }); }
/** A tab by its words inside a control named by its label. */
async function pick(control: string, words: string) {
  const tab = all(`[aria-label="${control}"] button`).find((button) => button.textContent === words);
  expect(tab, `${control}: ${words}`).toBeDefined();
  await act(async () => { (tab as HTMLButtonElement).click(); });
}

// Desktop tests run in happy-dom at 1024px wide; the charts measure no box there and draw at their fallback width.
async function show() {
  const demo = createDemo(1_000_000_000);
  simulator = new Simulator({ ...demo.state, pool: { ...demo.state.pool, paused: true } }, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
  const state = simulator.getState();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AnalyticsPage state={state} find={lookup(state)} product="all" about={false} onAboutSeen={() => {}} onOpen={() => {}} />));
  // The numbers arrive after the first render.
  await act(async () => { await Promise.resolve(); });
}
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Analytics charts', () => {
  it('shows exact known amounts, missing reports and incomplete running totals consistently in tooltips and tables', async () => {
    await show();
    const props = {
      series: [{ key: 'grok', label: 'Grok', color: 'red' }],
      points: [
        { key: 'zero', label: '1', title: 'Zero reported', values: { grok: 0 } },
        { key: 'missing', label: '2', title: 'Missing report', values: { grok: 0 }, missing: { grok: true } },
        { key: 'partial', label: '3', title: 'Partial report', values: { grok: 1234567 }, missing: { grok: true } },
        { key: 'empty', label: '4', title: 'No activity', values: {} },
      ] as BarPoint[],
      format: () => '1.2M', formatDetail: (value: number) => value.toLocaleString('en-US'), label: 'Reported tokens', periodWord: 'Day', measureWord: 'Tokens',
      running: { label: 'Running total', values: [0, 0, 1234567, 1234567] },
    };
    await act(async () => root.render(<BarsOverTime {...props} table={false} />));
    const hits = all('rect.hit');
    await act(async () => { hits[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    expect(el('[role="tooltip"]').textContent).toContain('Grok not reported');
    await act(async () => { hits[2]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    expect(el('[role="tooltip"]').textContent).toContain('Grok at least 1,234,567');
    await act(async () => root.render(<BarsOverTime {...props} table />));
    const rows = all('tbody tr').map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['0', '0', '0'],
      ['not reported', 'not reported', 'not reported'],
      ['at least 1,234,567', 'at least 1,234,567', 'at least 1,234,567'],
      ['0', '0', 'at least 1,234,567'],
    ]);
    await act(async () => root.render(<BarsOverTime {...props} table missingWord="not known" />));
    expect(all('tbody tr')[1]!.textContent).toContain('not known');
  });

  it('breaks a limit line at its reset and does not carry an expired reading into the next window', async () => {
    await show();
    await act(async () => root.render(<LinesOverTime from={0} to={100} ticks={[]} table={false} label="Account limits" format={(value) => `${value * 100}%`} when={String} series={[
      { key: 'short', label: '5-hour', color: 'red', points: [{ at: 10, value: 1 }, { at: 80, value: 0.2 }], resets: [50] },
      { key: 'week', label: 'weekly', color: 'blue', points: [{ at: 60, value: 0.5 }], resets: [] },
    ]} />));
    expect(el('path.series-line').getAttribute('d')!.match(/M/g)).toHaveLength(2);
    expect(el('path.series-line').getAttribute('d')).not.toContain('L');
    const svg = el('svg[role="img"]');
    // ArrowLeft starts from the most recent reading; the next one is after the short window reset.
    await act(async () => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    await act(async () => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(el('[role="tooltip"]').textContent).toContain('weekly 50%');
    expect(el('[role="tooltip"]').textContent).not.toContain('5-hour');
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

  it('draws each tool\'s limits over time with the resets marked, the latest percentage in the legend, and a table', async () => {
    await show();
    const charts = all('.limits-charts .chart-figure');
    expect(charts).toHaveLength(2);
    expect(charts.map((chart) => chart.querySelector('.chart-title')?.textContent)).toEqual(['Claude Code', 'Codex']);
    const claude = charts[0]!;
    expect([...claude.querySelectorAll('.legend > span:not(.reset-key)')].map((entry) => entry.textContent)).toEqual(['5-hour35%', 'weekly62%']);
    expect(claude.querySelector('.legend .reset-key')?.textContent).toBe('reset');
    expect(claude.querySelectorAll('svg path.series-line')).toHaveLength(2);
    expect(claude.querySelectorAll('svg g.reset:not(.ahead)').length).toBeGreaterThan(3);
    expect(charts[1]!.querySelectorAll('svg path.series-line')).toHaveLength(1);

    await pick('Limits as a chart or a table', 'Table');
    const table = el('.limits-charts table.chart-table');
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['When', 'Limit', 'Used']);
    expect(table.textContent).toContain('reset');
    expect(table.textContent).toContain('62%');
  });

  it('charts the hours of today when the period is Today', async () => {
    await show();
    await click('[aria-label="Period"] button:first-child');
    await act(async () => { await Promise.resolve(); });
    expect(el('.chart-head.tokens').textContent).toContain('per hour, today');
    expect(el('.analytics .chart-figure:has(.hit)').querySelectorAll('svg rect.hit')).toHaveLength(24);
    // The 5-hour window's next reset is still ahead today, marked more quietly.
    expect(el('.limits-charts .chart-figure svg g.reset.ahead')).not.toBeNull();
  });
});

// The review of "Show what each task costs" raised these on the Analytics page; they stay fixed.
describe('the Analytics page after review', () => {
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
    expect(host.textContent).not.toMatch(/[—–]/);
    await click('label.toggle input');
    expect(el<HTMLInputElement>('label.toggle input').checked).toBe(true);
    const cells = all('.split-row:not(.head) [role="cell"]').map((cell) => cell.textContent ?? '');
    expect(cells.some((text) => text === 'not reported')).toBe(true);
    expect(host.textContent).not.toMatch(/[—–]/);
  });

  it('never turns unknown profile time into "under a minute", and says "at least" when a lost turn is mixed in', async () => {
    await show();
    await act(async () => root.render(
      <div>
        <FigureText figure={{ atLeast: true, unknown: true }} kind="time" />
        <FigureText figure={{ atLeast: true, value: 30_000 }} kind="time" />
        <FigureText figure={{ atLeast: false, value: 30_000 }} kind="time" />
        <FigureText figure={{ atLeast: true, value: 3_600_000 }} kind="time" />
      </div>,
    ));
    expect(all('.num').map((cell) => cell.textContent)).toEqual(['not known', 'at least a few seconds', 'under a minute', 'at least 1h 00m']);
  });
});
