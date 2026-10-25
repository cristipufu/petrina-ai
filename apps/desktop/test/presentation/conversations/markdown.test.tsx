

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBody } from '../../../src/components/MessageBody';

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));

vi.mock('../../../src/engine', () => ({ sim: { previewImage: preview }, failureText: (failure: unknown) => failure instanceof Error ? failure.message : String(failure) }));

let host: HTMLDivElement;

let root: Root;

const disconnect = vi.fn();

const createUrl = vi.fn(() => 'blob:screenshot');

const revokeUrl = vi.fn();

const image = { mime: 'image/png', data: 'AQID' };

beforeEach(() => {
  preview.mockReset().mockResolvedValue(image);
  createUrl.mockClear(); revokeUrl.mockClear(); disconnect.mockClear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(_callback: IntersectionObserverCallback) {}
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('local screenshot links in public messages', () => {
  it('renders paragraphs, headings, emphasis and readable noninteractive task lists', async () => {
    const text = 'I will review the current screens.\n\n**To-do list**\n- [ ] Review existing guidelines\n- [x] Shape the routine editor\n\n## Evidence\n\n1. Read the current source\n2. Check the result\n\n> Keep the saved intent.\n\n[Documentation](https://example.com/guide)';
    await act(async () => root.render(<MessageBody taskId="task-1" text={text} />));
    expect(host.querySelector('strong')?.textContent).toBe('To-do list');
    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes.map(input => input.checked)).toEqual([false, true]);
    expect(checkboxes.every(input => input.disabled)).toBe(true);
    expect(host.querySelectorAll('ol li')).toHaveLength(2);
    expect(host.querySelector('h2')?.textContent).toBe('Evidence');
    expect(host.querySelector('blockquote')?.textContent).toContain('Keep the saved intent.');
    expect(host.querySelector('a')?.getAttribute('rel')).toContain('noopener');
    expect(host.textContent).not.toContain('- [ ]');
  });

  it('updates incomplete streamed Markdown and keeps raw HTML and unsafe links inactive', async () => {
    await act(async () => root.render(<MessageBody taskId="task-1" text="**Working" />));
    expect(host.textContent).toContain('Working');
    await act(async () => root.render(<MessageBody taskId="task-1" text={'**Working**\n\n- [ ] Review\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert)\n\n![Remote](https://example.com/image.png)'} />));
    expect(host.querySelector('strong')?.textContent).toBe('Working');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.querySelector('img[src^="http"]')).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it('recognizes local Markdown links without fetching websites or unrelated paths', async () => {
    await act(async () => root.render(<MessageBody taskId="task-1" text={'Shots: [Light](/task/light.png) · ![Dark](<screenshots/dark theme.webp>) · [File](file:///task/light%20theme.png)'} />));
    expect(host.querySelectorAll('.message-image')).toHaveLength(3);
    for (const text of ['Plain <script> remains text', '[Website](https://example.com/image.png)', '[Network](//remote/image.png)', '[Document](/task/README.md)', '[SVG](/task/image.svg)']) {
      await act(async () => root.render(<MessageBody taskId="task-1" text={text} />));
      expect(host.querySelector('.message-image')).toBeNull();
    }
    expect(preview).not.toHaveBeenCalled();
  });
});
