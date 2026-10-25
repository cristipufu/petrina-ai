

import { vi } from "vitest";
vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: {} }));
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from "vitest";
import { BarsOverTime, type BarPoint } from '../../../src/components/Charts';
import { FigureText } from '../../../src/components/Usage';

let root: Root;

let host: HTMLDivElement;

function el<T extends HTMLElement = HTMLElement>(selector: string): T { const found = host.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }

function all(selector: string) { return [...host.querySelectorAll(selector)]; }

async function show() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }

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
    expect(el('[role="tooltip"]').textContent).toContain('Grok > 1,234,567');
    await act(async () => root.render(<BarsOverTime {...props} table />));
    const rows = all('tbody tr').map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['0', '0', '0'],
      ['not reported', 'not reported', 'not reported'],
      ['> 1,234,567', '> 1,234,567', '> 1,234,567'],
      ['0', '0', '> 1,234,567'],
    ]);
    await act(async () => root.render(<BarsOverTime {...props} table missingWord="not known" />));
    expect(all('tbody tr')[1]!.textContent).toContain('not known');
  });
});

describe('the Analytics page after review', () => {

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
    expect(all('.num').map((cell) => cell.textContent)).toEqual(['not known', '> a few seconds', 'under a minute', '> 1h 00m']);
  });
});
