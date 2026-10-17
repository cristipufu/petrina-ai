import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoState, type State } from '@petrina/core';
import { UsageList, usageNote } from '../src/components/Usage';

vi.mock('../src/engine', () => ({ mode: 'demo', desktop: false, sim: {} }));

let root: Root;
let host: HTMLDivElement;
async function show(state: State) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<UsageList state={state} />));
}
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('usage by tool', () => {
  it('shows the demo with one tool near its limit and the other fine, in plain words', async () => {
    const state = createDemoState(1_000_000_000);
    await show(state);
    const rows = [...host.querySelectorAll('.usage-row')].map((row) => row.textContent);
    expect(rows).toEqual(['Claude Codeweekly 82% · 5-hour 35%', 'Codexfine']);
    expect(host.querySelector('.usage-row .label.warn')?.textContent).toBe('weekly 82% · 5-hour 35%');
    expect(usageNote(state)).toBe('Claude Code: weekly 82% · 5-hour 35%');
  });

  it('says who is out and until when', async () => {
    const state = createDemoState(1_000_000_000);
    const until = state.now + 2 * 60 * 60_000;
    await show({ ...state, pool: { ...state.pool, limited: [{ toolId: 'codex', until, reason: "Codex's usage limit" }] } });
    const codex = [...host.querySelectorAll('.usage-row')].find((row) => row.textContent?.startsWith('Codex'))!;
    expect(codex.textContent).toMatch(/^Codexout until (\d\d:\d\d|\w{3} \d\d:\d\d)$/);
    expect(codex.querySelector('.label.bad')).not.toBeNull();
  });

  it('has nothing to flag when every tool is fine', () => {
    const state = createDemoState(1_000_000_000);
    expect(usageNote({ ...state, pool: { ...state.pool, usage: [] } })).toBeUndefined();
  });
});
