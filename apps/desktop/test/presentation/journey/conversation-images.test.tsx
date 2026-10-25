vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDemoState } from "@petrina/core";
import { Journey } from '../../../src/components/Journey';
import { lookup } from '../../../src/lib';

const { image, previewImage } = vi.hoisted(() => ({ image: vi.fn(), previewImage: vi.fn() }));

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: { image, previewImage, synced: () => true }, useUnsent: () => [], useEngineStatus: () => ({ link: 'live' }), failureText: (reason: Error) => reason.message }));

let host: HTMLDivElement;

let root: Root;

let observer: IntersectionObserverCallback;

async function visible(...values: boolean[]) {
  await act(async () => observer((values.length ? values : [true]).map((value) => ({ isIntersecting: value } as IntersectionObserverEntry)), {} as IntersectionObserver));
}

const revoked = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
  });
  image.mockResolvedValue(new Blob(['picture'], { type: 'image/png' }));
  previewImage.mockResolvedValue({ mime: 'image/png', data: 'AQID' });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:checked-page');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoked);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); image.mockReset(); previewImage.mockReset(); revoked.mockReset(); });

it('loads a selected step’s pictures in its Conversation tab, keeping the Timeline separate', async () => {
  const state = createDemoState(1_000_000);
  const original = state.tasks.find((task) => task.id === 'pricing-refresh')!;
  const builder = original.journey!.find((step) => step.roleId === 'builder')!;
  const task = { ...original, session: [
    { id: 'builder-picture-report', at: builder.startedAt!, from: 'agent' as const, roleId: 'builder', step: builder.id, text: 'The builder checked the page', images: [{ id: 'chosen-picture', caption: 'The page after the change' }] },
  ] };
  await act(async () => root.render(<Journey task={task} state={state} find={lookup(state)} onReadSession={() => {}} onPlan={() => {}} />));
  const step = host.querySelector<HTMLElement>(`li[data-step-id="${builder.id}"]`)!;
  await act(async () => step.focus());
  await act(async () => step.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const details = host.querySelector('.journey-details')!;
  await act(async () => details.querySelector<HTMLButtonElement>('[data-journey-tab="timeline"]')!.click());
  expect(host.querySelector('.step-conversation')).toBeNull();
  expect(image).not.toHaveBeenCalled();
  await act(async () => details.querySelector<HTMLButtonElement>('[data-journey-tab="conversation"]')!.click());
  await visible();
  expect(image).toHaveBeenCalledWith(task.id, 'chosen-picture');
  expect(details.querySelector('.message-image')?.closest('.msg')?.textContent).toContain('The builder checked the page');
  expect(details.querySelector('.message-image-caption')?.textContent).toBe('The page after the change');
});
