import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { limitBuckets, limitsOverTime, readingsView, type ReadingsRequest, type ReadingsView, type UsagePeriod, type UsageReport } from "@petrina/core";
import { LimitHistory, bucketDescription, bucketValue } from "../src/components/LimitHistory";

const now = new Date(2026, 9, 22, 14).getTime();
const hour = 3600000;
const history: UsageReport[] = Array.from({ length: 70 }, (_, index) => ({ toolId: "antigravity", kind: "five_hour", model: "gemini", name: "Gemini Models", status: "allowed", utilization: index / 100, at: now - (70 - index) * 60000 }));
history.push({ ...history[0]!, model: "flash", at: now - 48 * hour, utilization: 0 });
history.push({ ...history[0]!, model: "argon", kind: "seven_day", name: "Gemini 4 Argon", at: now - 48 * hour, utilization: 1 });
const current = [history[69]!];
const load = vi.fn((request: ReadingsRequest): ReadingsView | Promise<ReadingsView> => readingsView(history, current, request));
vi.mock('../src/engine', () => ({ sim: { usage: (request: ReadingsRequest) => load(request) } }));
let root: Root;
let host: HTMLDivElement;
const el = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const buttons = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
const view = (period: UsagePeriod) => limitsOverTime(history, current, limitBuckets(period, now), period === "today", now, id => id);
async function render(period: UsagePeriod, loading = false) {
  if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root.render(<LimitHistory history={loading ? undefined : view(period)} period={period} />));
}
async function click(text: string) { await act(async () => buttons(text).click()); }
async function choose(key: string) { await act(async () => { const select = el<HTMLSelectElement>('select'); select.value = key; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
afterEach(() => { act(() => root.unmount()); host.remove(); host = undefined!; load.mockReset(); load.mockImplementation(request => readingsView(history, current, request)); });

it('remembers selections through periods and loading, and remembers an existing page per period', async () => {
  await render('30d');
  await click('Table');
  for (let index = 0; index < 3; index++) await click('Older');
  expect(el('.limit-history-pager').textContent).toContain('Page 4 of 5');
  await choose('antigravity|seven_day|argon');
  expect(el('.limit-history-membership').textContent).toContain('100%, limit reached then');
  expect(el('.limit-history-card').classList.contains('limit-history-only')).toBe(true);
  await render('7d', true);
  await render('7d');
  expect(el<HTMLSelectElement>('select').value).toBe('antigravity|seven_day|argon');
  expect(el('.limit-history-pager').textContent).toContain('Page 1 of 1');
  await render('today');
  expect(el('.limit-history-pager').textContent).toContain('Page 1 of 3');
  expect(el('.limit-history-card').textContent).toContain('No readings recorded for these dates');
  await render('30d');
  expect(el('.limit-history-pager').textContent).toContain('Page 4 of 5');
  expect(host.querySelectorAll('tbody tr')).toHaveLength(7);
});

it('uses a single chart tab stop, opens the focused bucket, bounds readings and restores focus and scope', async () => {
  await render('7d');
  const chartId = el('.limit-history-plot').id;
  expect(host.querySelectorAll('.limit-history-chart [tabindex="0"]')).toHaveLength(1);
  await act(async () => el('.limit-history-plot').focus());
  await act(async () => el('.limit-history-plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  const bucket = view('7d').tools[0]!.limits.find(limit => limit.current)!.buckets.at(-1)!;
  expect(el('[role="tooltip"]').textContent).toBe(bucketDescription(bucket, false));
  expect(bucketValue(bucket)).toBe('69%');
  await act(async () => el('.limit-history-plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(load.mock.calls[0]![0]).toMatchObject({ from: bucket.start, to: bucket.end, offset: 0 });
  expect(host.querySelectorAll('tbody tr')).toHaveLength(20);
  expect(el('.limit-history-readings-view').textContent).toContain('Possible reset means'.toLowerCase());
  await click('Older');
  expect(load.mock.calls.at(-1)![0].offset).toBe(20);
  await click('Newer');
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement?.id).toBe(chartId);
  expect(el('[role="tooltip"]').textContent).toBe(bucketDescription(bucket, false));
  await act(async () => el('.limit-history-plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
});

it.each(['first', 'last'])('keeps focus and Escape working at the %s readings page', async end => {
  await render('30d');
  const returnId = buttons('View readings').id;
  await click('View readings');
  await click('Older');
  const direction = end === 'first' ? 'Newer' : 'Older';
  await act(async () => buttons(direction).focus());
  for (let index = 0; index < (end === 'first' ? 1 : 2); index++) await click(direction);
  const atEnd = buttons(direction);
  expect(el('.limit-history-pager').textContent).toContain(end === 'first' ? 'Page 1' : 'Page 4');
  expect(document.activeElement).toBe(atEnd);
  // Unavailable actions remain focusable so a browser never drops focus to the page.
  expect(atEnd.disabled).toBe(false);
  expect(atEnd.getAttribute('aria-disabled')).toBe('true');
  const requests = load.mock.calls.length;
  await click(direction);
  expect(load).toHaveBeenCalledTimes(requests);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(host.querySelector('.limit-history-readings-view')).toBeNull();
  expect(document.activeElement?.id).toBe(returnId);
});

it('keeps the paging control focused while a page loads and ignores extra activations', async () => {
  await render('30d');
  await click('View readings');
  const older = buttons('Older');
  let release!: (value: ReadingsView) => void;
  load.mockImplementationOnce(() => new Promise<ReadingsView>(resolve => { release = resolve; }));
  await act(async () => older.focus());
  await click('Older');
  expect(el('[role="status"]').textContent).toBe('Loading readings…');
  expect(older.isConnected).toBe(true);
  expect(document.activeElement).toBe(older);
  expect(older.getAttribute('aria-disabled')).toBe('true');
  await click('Older');
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => release(readingsView(history, current, load.mock.calls[1]![0])));
  expect(document.activeElement).toBe(older);
  expect(el('.limit-history-pager').textContent).toContain('Page 2');
  expect(host.querySelectorAll('tbody tr')).toHaveLength(20);
  expect(older.getAttribute('aria-disabled')).toBe('false');
});

it('keeps a hovered day when the chart has keyboard focus, including arrow movement and Enter', async () => {
  await render('7d');
  const chart = el('.limit-history-plot');
  const slots = [...host.querySelectorAll('.limit-history-slot')];
  const buckets = view('7d').tools[0]!.limits.find(limit => limit.current)!.buckets;
  await act(async () => chart.focus());
  await act(async () => slots[4]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  const selected = el('[role="tooltip"]').textContent;
  await act(async () => chart.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: host })));
  expect(document.activeElement).toBe(chart);
  expect(el('[role="tooltip"]').textContent).toBe(selected);
  expect(chart.getAttribute('aria-describedby')).toBe(el('[role="tooltip"]').id);
  await act(async () => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(el('[role="tooltip"]').textContent).toBe(bucketDescription(buckets[5]!, false));
  await act(async () => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(load.mock.calls[0]![0]).toMatchObject({ from: buckets[5]!.start, to: buckets[5]!.end });
  await click('Back to usage history');
  await act(async () => el('.limit-history-plot').blur());
  await act(async () => el('.limit-history-slot').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => el('.limit-history-plot').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: host })));
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
});

it('shows bar values only when the actual text fits, and restores them when space returns', async () => {
  let labelWidth = 9;
  let plotWidth = 303;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  const dimensions = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('limit-history-axis')) return new DOMRect(0, 0, plotWidth, 32);
    if (this.parentElement?.classList.contains('limit-history-bar')) return new DOMRect(0, 0, labelWidth, 30);
    if (this.hasAttribute('data-measure')) return new DOMRect(0, 0, 35, 16);
    return measure.call(this);
  });
  vi.stubGlobal('ResizeObserver', undefined);
  try {
    await render('30d');
    expect(el('.limit-history-plot').classList.contains('compact-values')).toBe(false);
    labelWidth = 18;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(el('.limit-history-plot').classList.contains('compact-values')).toBe(true);
    await choose('antigravity|five_hour|flash');
    expect(el('.limit-history-bar.zero').textContent).toBe('0%');
    expect(el('.limit-history-zero-key').textContent).toContain('0%');
    await act(async () => el('.limit-history-plot').focus());
    await act(async () => el('.limit-history-plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    await act(async () => el('.limit-history-plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(el('[role="tooltip"]').textContent).toContain('0%');
    plotWidth = 840;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(el('.limit-history-plot').classList.contains('compact-values')).toBe(false);
    expect(host.querySelector('.limit-history-zero-key')).toBeNull();
  } finally { dimensions.mockRestore(); vi.unstubAllGlobals(); }
});

it('leaves dates before the first report blank, preserving a later missing day, zero and status report', async () => {
  await render('7d');
  const reports: UsageReport[] = [
    { ...history[0]!, at: now - 48 * hour, utilization: 0 },
    { ...history[0]!, at: now, utilization: undefined, status: 'rejected' },
  ];
  await act(async () => root.render(<LimitHistory period="7d" history={limitsOverTime(reports, [], limitBuckets('7d', now), false, now, id => id)} />));
  const spaces = [...host.querySelectorAll('.limit-history-bar-space')];
  expect(spaces.slice(0, 4).every(space => !space.hasChildNodes())).toBe(true);
  expect(spaces[4]!.querySelector('.zero')?.textContent).toBe('0%');
  expect(spaces[5]!.textContent).toBe('·');
  expect(spaces[6]!.textContent).toBe('◇');
  await act(async () => el('.limit-history-plot').focus());
  await act(async () => el('.limit-history-plot').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(el('[role="tooltip"]').textContent).toContain('No readings recorded');
  await click('Table');
  expect(host.querySelectorAll('tbody tr')).toHaveLength(7);
  expect(el('tbody').textContent).toContain('No readings recorded');
});

it('keeps zero, status-only and missing buckets truthful in matching chart and table text', async () => {
  await render('7d');
  await choose('antigravity|five_hour|flash');
  expect(el('.limit-history-bar.zero').textContent).toBe('0%');
  await click('Table');
  expect(el('.limit-history-table').textContent).toContain('No readings recorded');
  expect(el('.limit-history-table').textContent).toContain('0%');
});

it('draws a status-only bucket as no percentage in both views', async () => {
  await render('7d');
  const report: UsageReport = { toolId: "antigravity", kind: "five_hour", model: "status", status: "rejected", at: now };
  await act(async () => root.render(<LimitHistory period="7d" history={limitsOverTime([report], [], limitBuckets("7d", now), false, now, id => id)} />));
  expect(el('.limit-history-unknown.status-only').textContent).toBe('◇');
  expect(host.querySelector('.limit-history-bar')).toBeNull();
  await click('Table');
  expect(el('.limit-history-table tbody tr').textContent).toContain('No percentage');
  expect(el('.limit-history-table tbody tr').textContent).not.toContain('100%');
});

it('distinguishes a first day of history from a Today view of an older allowance', async () => {
  await render('today');
  expect(el('.limit-history-card').textContent).toContain('Only today has readings');
  const recorded = [{ ...history[0]!, at: now - 20 * 24 * hour }, ...history];
  const today = limitsOverTime(recorded, current, limitBuckets('today', now), true, now, id => id);
  await act(async () => root.render(<LimitHistory period="today" history={today} />));
  expect(el('.limit-history-card').textContent).not.toContain('Only today has readings');
  expect(el('.limit-history-card').textContent).toContain('hours so far · first at');
  expect(today.tools[0]!.limits.find(limit => limit.current)!.firstAt).toBe(now - 20 * 24 * hour);
});

it('shows fractional reset jitter as unchanged while preserving original timestamps', async () => {
  const reset = Date.parse('2026-10-22T23:49:59.900Z');
  const reports = [0, 1, 2, 3].map(index => ({ ...history[0]!, at: now - (4 - index) * 60000, utilization: index / 100, resetsAt: reset + (index === 3 ? 60000 : index % 2 ? 200 : 0) }));
  load.mockImplementation(request => readingsView(reports, [], request));
  await render('today');
  await click('View readings');
  const rows = [...host.querySelectorAll('tbody tr')];
  expect(rows.map(row => row.children[2]!.textContent).filter(text => text === 'Unchanged')).toHaveLength(2);
  const jitter = rows[1]!.children[2]!.querySelector('time')!;
  expect(jitter.getAttribute('datetime')).toBe(new Date(reset).toISOString());
  expect(jitter.getAttribute('title')).toBeTruthy();
  expect(rows[0]!.children[2]!.textContent).not.toBe('Unchanged');
  expect(rows[0]!.children[3]!.textContent).toBe('Higher (was 2%)');
});
