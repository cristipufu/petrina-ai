

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoState, untilWords, type State } from "@petrina/core";
import { UsageList, usageNote } from "../../../src/components/Usage";

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: {} }));

let root: Root;

let host: HTMLDivElement;

async function show(state: State, expanded = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<UsageList state={state} expanded={expanded} />));
}

afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const MINUTE = 60_000;

describe('usage by tool', () => {
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
});
