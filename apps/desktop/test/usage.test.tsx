import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoState, untilWords, type State, type WorkUsageLine } from '@petrina/core';
import { SplitList, UsageList, usageNote } from '../src/components/Usage';

vi.mock('../src/engine', () => ({ mode: 'demo', desktop: false, sim: {} }));

let root: Root;
let host: HTMLDivElement;
async function show(state: State, expanded = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<UsageList state={state} expanded={expanded} />));
}
afterEach(() => { act(() => root.unmount()); host.remove(); });

const MINUTE = 60_000;

describe('usage by tool', () => {
  it('keeps the weekly meter separate from a refused request and labels its retry time', async () => {
    const state = createDemoState(1_000_000_000);
    const reason = 'Grok refused the request: Grok Build usage balance exhausted';
    await show({ ...state, tools: [...state.tools, { id: 'grok', name: 'Grok', command: ['grok'], models: [], status: 'ready' }], pool: { ...state.pool, usage: [{ toolId: 'grok', kind: 'seven_day', utilization: 0.42, status: 'allowed', at: state.now - 2 * 60 * MINUTE, resetsAt: state.now + 24 * 60 * MINUTE }], limited: [{ toolId: 'grok', retry: true, until: state.now + 5 * MINUTE, at: state.now, reason }] } }, true);
    const card = [...host.querySelectorAll('.limit-card')].find((node) => node.textContent?.includes('Grok'))!;
    expect(card.textContent).toContain('42% used');
    expect(card.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(card.textContent).toContain('request refused; retry after');
    expect(card.textContent).toContain(reason);
    expect(card.textContent).not.toContain('out until');
  });

  it('explains a failed refresh while keeping the last confirmed Grok allowance and report age', async () => {
    const state = createDemoState(1_000_000_000);
    await show({ ...state, tools: [...state.tools, { id: 'grok', name: 'Grok', command: ['grok'], models: ['Grok 4.7'], status: 'ready' }], pool: { ...state.pool, usage: [{ toolId: 'grok', kind: 'seven_day', utilization: 0.57, status: 'allowed', at: state.now - 2 * 60 * MINUTE, resetsAt: state.now + 24 * 60 * MINUTE }], usageReads: { grok: { at: state.now, state: 'unavailable' } } } }, true);
    const card = [...host.querySelectorAll('.limit-card')].find((node) => node.textContent?.includes('Grok'))!;
    expect(card.textContent).toContain('57% used');
    expect(card.textContent).toContain('reported 2h ago');
    expect(card.querySelector('[role="status"]')?.textContent).toBe('Couldn’t refresh usage. Showing the last report.');
  });
  it('shows the demo with Codex held back near its limit and Claude Code fine, each window with its reset time', async () => {
    const state = createDemoState(1_000_000_000);
    const at = (ms: number) => untilWords(state.now + ms, state.now);
    await show(state);
    const rows = [...host.querySelectorAll('.usage-row')].map((row) => `${row.querySelector('strong')?.textContent}${row.querySelector('.label')?.textContent}`);
    const claude = `weekly 62%, resets ${at(3 * 24 * 60 * MINUTE)} · 5-hour 35%, resets ${at(90 * MINUTE)}`;
    const codex = `weekly 84%, resets ${at(2 * 24 * 60 * MINUTE)} · starting fewer agents on it`;
    expect(rows).toEqual([`Claude Code${claude}`, `Codex${codex}`]);
    expect(host.querySelector('.usage-row .label.warn')?.textContent).toBe(codex);
    expect(usageNote(state)).toBe(`Codex: ${codex}`);
    expect(host.querySelector('.usage-reported')?.textContent).toContain('reported just now');
  });

  it('says who is out and until when', async () => {
    const state = createDemoState(1_000_000_000);
    const until = state.now + 2 * 60 * 60_000;
    await show({ ...state, pool: { ...state.pool, usage: [], limited: [{ toolId: 'codex', until, reason: "Codex's usage limit" }] } });
    const codex = [...host.querySelectorAll('.usage-row')].find((row) => row.textContent?.startsWith('Codex'))!;
    expect(codex.querySelector('.label')?.textContent).toMatch(/out until (\d\d:\d\d|\w{3} \d\d:\d\d)$/);
    expect(codex.querySelector('.label.bad')).not.toBeNull();
  });

  it('has nothing to flag when every tool is fine', () => {
    const state = createDemoState(1_000_000_000);
    expect(usageNote({ ...state, pool: { ...state.pool, usage: [] } })).toBeUndefined();
  });
  it('uses the same reports and blocked tools in Analytics', async () => {
    const state = createDemoState(1_000_000_000);
    const at = state.now - 2 * 60_000;
    const until = state.now + 60 * 60_000;
    await show({ ...state, pool: { ...state.pool, limited: [{ toolId: 'codex', until, at, reason: "Codex's usage limit" }] } }, true);
    const meters = [...host.querySelectorAll('[role="meter"]')];
    expect(meters.map((meter) => Number(meter.getAttribute('aria-valuenow')))).toEqual([62, 35, 84]);
    expect(host.textContent).toContain('reported just now');
    expect(host.textContent).toContain('out until');
    expect(host.textContent).toContain('Reported 2m ago');
  });

  it('keeps an exhausted extra-usage limit beside an open five-hour allowance from the same report', async () => {
    const state = createDemoState(1_000_000_000);
    const resetsAt = state.now + 3 * 60 * 60_000;
    const usage = [
      { toolId: 'claude-code', kind: 'five_hour', status: 'allowed' as const, utilization: 0.4, at: state.now },
      { toolId: 'claude-code', kind: 'overage', status: 'rejected' as const, resetsAt, at: state.now },
    ];
    await show({ ...state, pool: { ...state.pool, usage } }, true);
    const claude = [...host.querySelectorAll('.limit-card')].find((card) => card.textContent?.startsWith('Claude Code'))!;
    const limits = [...claude.querySelectorAll('.limit')].map((limit) => limit.querySelector('.row')?.textContent);
    expect(limits).toEqual(['5-hour40% used', 'extra usagelimit reached']);
    expect(claude.textContent).toContain('resets');
  });

  it('says not reported when neither tool has a report', async () => {
    const state = createDemoState(1_000_000_000);
    await show({ ...state, pool: { ...state.pool, usage: [] } }, true);
    expect(host.querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(host.textContent?.match(/Not reported/g)).toHaveLength(2);
  });

  it('does not describe Grok as Codex when no limits were reported', async () => {
    const state = createDemoState(1_000_000_000);
    await show({ ...state, tools: [...state.tools, { id: 'grok', name: 'Grok', command: ['grok'], models: [], status: 'ready' }] }, true);
    const grok = [...host.querySelectorAll('.limit-card')].find((card) => card.querySelector('strong')?.textContent === 'Grok')!;
    expect(grok.textContent).toBe('GrokNot reported. Petrina asks the installed Grok when this page opens.');
    expect(grok.textContent).not.toContain('Codex');
  });

  it('shows Grok’s reported weekly allowance and reset without financial details', async () => {
    const state = createDemoState(1_000_000_000);
    const grok = { id: 'grok', name: 'Grok', command: ['grok'], models: [], status: 'ready' as const };
    await show({ ...state, tools: [...state.tools, grok], pool: { ...state.pool, usage: [{ toolId: 'grok', kind: 'seven_day', utilization: 0.11, status: 'allowed', at: state.now, resetsAt: state.now + 3600000 }] } }, true);
    const meter = host.querySelector('[aria-label="Grok weekly"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('11');
    expect(meter.closest('.limit-card')!.textContent).toContain('11% used');
    expect(meter.closest('.limit-card')!.textContent).toContain('resets');
  });

  it('shows a passed reset instead of its old percentage', async () => {
    const state = createDemoState(1_000_000_000);
    await show({ ...state, pool: { ...state.pool, usage: [{ toolId: 'codex', kind: 'codex:primary', windowMinutes: 300, utilization: 0.99, status: 'allowed_warning', at: state.now - 60_000, resetsAt: state.now - 1 }] } }, true);
    expect(host.textContent).toContain('has reset since it was last reported');
    expect(host.textContent).not.toContain('99%');
    expect(host.querySelectorAll('[role="meter"]')).toHaveLength(0);
  });

  it('says not reported in every missing model detail, including a completely missing token report', async () => {
    await show(createDemoState(1_000_000_000));
    const lines: WorkUsageLine[] = [
      { key: 'partial', label: 'A model', tokens: { value: 120, atLeast: false }, time: { atLeast: false }, detail: { input: 100, output: 20 } },
      { key: 'missing', label: 'Another model', tokens: { atLeast: true }, time: { value: 60_000, atLeast: false }, detail: {} },
    ];
    await act(async () => root.render(<SplitList title="By model" lines={lines} details color={() => 'blue'} />));
    const rows = [...host.querySelectorAll('.split-row:not(.head)')];
    expect([...rows[0]!.querySelectorAll('[role="cell"]')].slice(-4).map((cell) => cell.textContent)).toEqual(['100', 'not reported', 'not reported', '20']);
    expect([...rows[1]!.querySelectorAll('[role="cell"]')].slice(-4).map((cell) => cell.textContent)).toEqual(Array(4).fill('not reported'));
    expect(host.textContent).not.toMatch(/[—–]/);
  });

});
