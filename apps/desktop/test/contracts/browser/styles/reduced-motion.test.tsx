vi.mock("../../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { vi } from "vitest";
vi.mock("../../../../src/engine", () => ({ mode: "demo", desktop: false, sim: {} }));
import { act } from "react";
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Window as HappyWindow } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type JourneyView } from "@petrina/core";
import { JourneyEdge } from "../../../../src/components/Journey";
import { layoutJourney } from '../../../../src/journeyLayout';

const NOW = 1_000_000_000_000;

let root: Root;

let host: HTMLDivElement;

async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

beforeEach(() => localStorage.clear());

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the live arrow with reduced motion', () => {
  it.each(['back', 'stuck', 'on'] as const)('stays solid and stronger after %s, keeping its colour', async (tone) => {
    const device = (window as unknown as HappyWindow).happyDOM.settings.device;
    const previous = device.prefersReducedMotion;
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../../../../src/styles.css'), 'utf8');
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
