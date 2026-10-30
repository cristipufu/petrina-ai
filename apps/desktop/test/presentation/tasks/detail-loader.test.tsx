import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Task, type TaskDetailsUpdate } from "@petrina/core";
import { useTaskDetails } from "../../../src/task-details";

const read = vi.hoisted(() => vi.fn<(id: string) => Promise<Task | undefined>>());
const deltaApi = vi.hoisted(() => ({ fn: undefined as ((id: string, since: string) => Promise<TaskDetailsUpdate | undefined>) | undefined }));

vi.mock("../../../src/engine", () => ({
  sim: {
    taskDetails: read,
    get taskDetailsDelta() {
      return deltaApi.fn;
    },
  },
  failureText: (error: unknown) => (error as Error).message,
}));

const task = oneTaskFixture(1_000_000_000).tasks[0]!;

let root: Root, host: HTMLDivElement;

function View({ id = task.id, revision = "boot:1", history = 1, archived = false, retry = 0, needed = true }: { id?: string; revision?: string; history?: number; archived?: boolean; retry?: number; needed?: boolean }) {
  const result = useTaskDetails(id, needed, revision, history, archived, retry);
  return <p>{result?.task?.title ?? result?.error ?? "Loading"}</p>;
}

beforeEach(() => {
  vi.useFakeTimers(); read.mockReset(); deltaApi.fn = undefined;
  read.mockImplementation(async id => ({ ...task, id, detailsRevision: "boot:1" }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

const show = async (props: Parameters<typeof View>[0] = {}) => act(async () => root.render(<View {...props} />));

const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("owns no idle timer and coalesces changed revisions into one read after 400ms", async () => {
  await show();
  expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  await advance(100); await show({ revision: "boot:2" });
  await advance(100); await show({ revision: "boot:3" });
  expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
  read.mockResolvedValueOnce({ ...task, title: "Latest details", detailsRevision: "boot:3" });
  await advance(200);
  expect(read).toHaveBeenCalledTimes(2); expect(host.textContent).toBe("Latest details");
  expect(vi.getTimerCount()).toBe(0);
  await advance(10_000); expect(read).toHaveBeenCalledTimes(2);
});

it("uses a live response's revision when it advances in flight without refetching it", async () => {
  let finish!: (value: Task) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await show(); await show({ revision: "boot:2" });
  await act(async () => finish({ ...task, detailsRevision: "boot:2" }));
  await advance(1000);
  expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  // A response ahead of the websocket also stays idle until a new notification.
  read.mockResolvedValueOnce({ ...task, detailsRevision: "boot:4" });
  await show({ revision: "boot:3" }); await advance(1000);
  expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  await show({ revision: "boot:4" }); await advance(1000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("refreshes archived tasks from history changes, without comparing them to live revision tokens", async () => {
  await show({ archived: true });
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  read.mockResolvedValueOnce({ ...task, title: "Cleanup completed", detailsRevision: "boot:99" });
  await show({ archived: true, history: 2 });
  expect(host.textContent).toBe("Cleanup completed");
  await advance(1000); expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});

it("serializes requests and discards replies after a task switch or closing the sheet", async () => {
  let finish!: (value: Task) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await show(); await show({ revision: "boot:2" }); await advance(1000);
  expect(read).toHaveBeenCalledTimes(1);
  await show({ id: "another" });
  expect(read).toHaveBeenLastCalledWith("another");
  await act(async () => finish({ ...task, title: "Old task" }));
  expect(host.textContent).not.toBe("Old task");
  await show({ needed: false }); expect(host.textContent).toBe("Loading");
  await advance(1000); expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});

it("retries errors only on an explicit retry or a new revision, without an idle loop", async () => {
  read.mockRejectedValueOnce(new Error("Disconnected"));
  await show(); expect(host.textContent).toBe("Disconnected");
  await advance(1000); expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  await show({ retry: 1 }); expect(host.textContent).toBe(task.title);
  expect(read).toHaveBeenCalledTimes(2);
});

it("streams incremental taskDetailsDelta updates after the initial full load while keeping archived reads full", async () => {
  const delta = vi.fn<(id: string, since: string) => Promise<TaskDetailsUpdate | undefined>>();
  deltaApi.fn = delta;
  await show();
  expect(read).toHaveBeenCalledExactlyOnceWith(task.id);
  expect(delta).not.toHaveBeenCalled();

  const { session: _s, timeline: _t, journey: _j, designSessions: _ds, reviewSessions: _rs, handedBack: _hb, ...summary } = task;
  delta.mockResolvedValueOnce({
    kind: "delta",
    baseRevision: "boot:1",
    detailsRevision: "boot:2",
    summary: { ...summary, title: "Streamed via delta" },
    session: { upserts: [{ id: "stream-1", at: 42, from: "agent", text: "Incremental line" }] },
  });
  await advance(400);
  await show({ revision: "boot:2" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(delta).toHaveBeenCalledExactlyOnceWith(task.id, "boot:1");
  expect(host.textContent).toBe("Streamed via delta");
});
