import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBody, messageParts } from '../src/components/MessageBody';

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('../src/engine', async (original) => ({ ...await original<typeof import('../src/engine')>(), sim: { previewImage: preview } }));
let host: HTMLDivElement;
let root: Root;
let observer: IntersectionObserverCallback;
const disconnect = vi.fn();
const createUrl = vi.fn(() => 'blob:screenshot');
const revokeUrl = vi.fn();
const image = { mime: 'image/png', data: 'AQID' };
async function visible(value: boolean) {
  await act(async () => { observer([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver); });
}
async function render(finished = false) {
  await act(async () => root.render(<MessageBody taskId="task-1" text="Checked both themes. [Light](/task/screenshots/light.png)" finished={finished} />));
}

beforeEach(() => {
  preview.mockReset().mockResolvedValue(image);
  createUrl.mockClear(); revokeUrl.mockClear(); disconnect.mockClear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observer = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('local screenshot links in public messages', () => {
  it('recognizes local Markdown links and leaves websites and unrelated text untouched', () => {
    expect(messageParts('Shots: [Light](/task/light.png) · ![Dark](<screenshots/dark theme.webp>)')).toEqual([
      { kind: 'text', text: 'Shots: ' }, { kind: 'image', label: 'Light', path: '/task/light.png' },
      { kind: 'text', text: ' · ' }, { kind: 'image', label: 'Dark', path: 'screenshots/dark theme.webp' },
    ]);
    for (const text of ['Plain <script> remains text', '[Website](https://example.com/image.png)', '[Network](//remote/image.png)', '[Document](/task/README.md)', '[SVG](/task/image.svg)']) {
      expect(messageParts(text)).toEqual([{ kind: 'text', text }]);
    }
    expect(messageParts('[Light](file:///task/light%20theme.png)')[0]).toEqual({ kind: 'image', label: 'Light', path: 'file:///task/light theme.png' });
  });

  it('reads images only near the viewport and releases their bytes when scrolled away', async () => {
    await render();
    expect(preview).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Checked both themes.');
    expect(host.textContent).not.toContain('/task/screenshots');
    await visible(true);
    expect(preview).toHaveBeenCalledWith('task-1', '/task/screenshots/light.png');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:screenshot');
    await visible(false);
    expect(host.querySelector('img')).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith('blob:screenshot');
    await visible(true);
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    expect(revokeUrl).toHaveBeenCalledTimes(2);
  });

  it('opens the full screenshot inline, closes on Escape and retains it only until closed', async () => {
    await render(); await visible(true);
    const open = host.querySelector<HTMLButtonElement>('.message-image-open')!;
    await act(async () => { open.focus(); open.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('img')?.getAttribute('alt')).toBe('Light screenshot');
    await visible(false);
    expect(revokeUrl).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(revokeUrl).toHaveBeenCalledTimes(1);
  });

  it('drops an in-flight image when its task finishes and never reads finished tasks', async () => {
    let resolve!: (payload: typeof image) => void;
    preview.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render(); await visible(true);
    await render(true);
    await act(async () => resolve(image));
    expect(createUrl).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Preview unavailable after the task finishes.');
    expect(host.querySelector('img')).toBeNull();
    preview.mockClear(); await render(true);
    expect(preview).not.toHaveBeenCalled();
  });

  it('shows a missing-file explanation and lets the coordinator retry without leaving the task', async () => {
    preview.mockRejectedValueOnce(new Error('This screenshot is no longer available in the task’s working copy.'));
    await render(); await visible(true);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('no longer available');
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click());
    expect(host.querySelector('img')).not.toBeNull();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('explains an older engine without exposing its command schema or JSON', async () => {
    preview.mockRejectedValueOnce(new Error('[{"code":"invalid_value","options":["addTask","cancel"],"path":["name"],"message":"Invalid option"}]'));
    await render(); await visible(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Preview will be available after the engine is updated.');
    expect(host.textContent).not.toMatch(/invalid_value|addTask|\[|\{/);
  });
});
