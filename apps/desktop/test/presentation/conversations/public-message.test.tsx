vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => {
    throw new Error("This presentation test did not request a native notification.");
  };
  return {
    platform: () => "linux",
    browserPermission: () => "unsupported",
    useBrowserPermission: () => "unsupported",
    askBrowser: async () => "unsupported",
    BrowserNotices: class {
      show = unexpected;
      test = unexpected;
      waiting() {}
    },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: () => {
    throw new Error("This presentation test did not request a native desktop operation.");
  },
}));

import { messagePage, type RecordedMessage, type SessionLine } from "@petrina/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Session, StepConversation } from "../../../src/components/Session";
import { lookup } from "../../../src/lib";
import { oneTaskFixture } from "../../fixtures/state";

const { publicMessage } = vi.hoisted(() => ({ publicMessage: vi.fn() }));
vi.mock("../../../src/engine", () => ({
  mode: "demo",
  desktop: false,
  sim: { publicMessage },
  useUnsent: () => [],
  useEngineStatus: () => ({ link: "live" }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  publicMessage.mockReset();
});

const body =
  "A paragraph with **emphasis**.\n\n"
  + "Public detail. ".repeat(2400)
  + "\n\nThe full ending is available. 😀";
const record: RecordedMessage = {
  text: body,
  recording: {
    recordedLength: body.length,
    originalLength: body.length,
    complete: true,
    state: "finished",
    revision: 2,
  },
};
const line: SessionLine = {
  id: "long",
  at: 1,
  from: "agent",
  roleId: "builder",
  text: body.slice(0, 2400),
  recording: record.recording,
};
const button = (text: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
async function click(text: string) {
  await act(async () => button(text).click());
}
function render(view: string, current = line, active = true) {
  const state = oneTaskFixture(1_000_000);
  const task = { ...state.tasks[0]!, session: [current] };
  return act(async () =>
    root.render(
      view === "task" ? (
        <Session.Log
          task={task}
          state={state}
          find={lookup(state)}
          scroller={{ current: host }}
          onTab={() => {}}
          active={active}
        />
      ) : (
        <StepConversation lines={[current]} find={lookup(state)} now={state.now} taskId={task.id} />
      ),
    ),
  );
}

for (const view of ["task", "step"]) {
  it(`keeps a nearby short message quiet when only trailing line breaks are outside its preview in the ${view} conversation`, async () => {
    const text = "The checks passed.\n\n";
    await render(view, {
      ...line,
      text: text.trimEnd(),
      recording: { ...record.recording, recordedLength: text.length, originalLength: text.length },
    });
    expect(host.querySelector(".message-markdown")?.textContent).toBe("The checks passed.");
    expect(button("Read full message")).toBeUndefined();
    expect(publicMessage).not.toHaveBeenCalled();
  });

  it(`opens bounded saved pages with formatting, releases text on collapse, and reloads in the ${view} conversation`, async () => {
    publicMessage.mockImplementation(async (_task, _id, offset, limit) => messagePage(record, offset, limit));
    await render(view);
    expect(host.textContent).not.toContain("The full ending");
    expect(publicMessage).not.toHaveBeenCalled();
    button("Read full message").focus();
    await click("Read full message");
    expect(publicMessage).toHaveBeenCalledTimes(2);
    expect(publicMessage.mock.calls.every((call) => call[3] <= 32000)).toBe(true);
    expect(host.textContent).toContain("The full ending is available. 😀");
    expect(host.querySelectorAll(".message-markdown p").length).toBe(3);
    expect(host.querySelector("strong")?.textContent).toBe("emphasis");
    expect(document.activeElement).toBe(button("Show less"));
    await click("Show less");
    expect(host.textContent).not.toContain("The full ending");
    await click("Read full message");
    expect(publicMessage).toHaveBeenCalledTimes(4);
    await render(view, { ...line, recording: { ...record.recording, revision: 3 } });
    expect(host.textContent).toContain("The full ending");
    expect(button("Read updated message")).toBeDefined();
  });

  it(`offers loading, failure and retry, and explains unavailable older endings in the ${view} conversation`, async () => {
    let reject!: (reason: Error) => void;
    publicMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await render(view);
    button("Read full message").focus();
    await click("Read full message");
    expect(button("Loading message…").disabled).toBe(false);
    expect(button("Loading message…").getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button("Loading message…"));
    await click("Loading message…");
    expect(publicMessage).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Disconnected")));
    expect(document.activeElement).toBe(button("Try again"));
    expect(host.textContent).toContain("Could not load the saved message");
    publicMessage.mockImplementation(async (_task, _id, offset, limit) => messagePage(record, offset, limit));
    await click("Try again");
    expect(host.textContent).toContain("The full ending");
    await click("Show less");
    await render(view, { id: "old", at: 1, from: "agent", text: `${"a".repeat(2400)}…` });
    expect(host.textContent).toContain("ending was not recorded");
    expect(button("Read full message")).toBeUndefined();
  });

  it(`keeps refresh focus nearby and lets readers move elsewhere during loading in the ${view} conversation`, async () => {
    publicMessage.mockImplementation(async (_task, _id, offset, limit) => messagePage(record, offset, limit));
    await render(view);
    await click("Read full message");
    const updated = { ...record, recording: { ...record.recording, revision: 3 } };
    await render(view, { ...line, recording: updated.recording });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    publicMessage.mockImplementation(async (_task, _id, offset, limit) => {
      await wait;
      return messagePage(updated, offset, limit);
    });
    button("Read updated message").focus();
    await click("Read updated message");
    expect(button("Read updated message").disabled).toBe(false);
    expect(document.activeElement).toBe(button("Read updated message"));
    await act(async () => release());
    expect(button("Read updated message")).toBeUndefined();
    expect(document.activeElement).toBe(button("Show less"));
    await click("Show less");
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    publicMessage.mockImplementation(async (_task, _id, offset, limit) => {
      await waiting;
      return messagePage(updated, offset, limit);
    });
    await click("Read full message");
    const elsewhere = document.createElement("button");
    host.append(elsewhere);
    elsewhere.focus();
    await act(async () => finish());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
}

it("discards an expansion still loading when the conversation is left, and makes a fresh read on return", async () => {
  let resolve!: (value: ReturnType<typeof messagePage>) => void;
  publicMessage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render("task");
  await click("Read full message");
  await render("task", line, false);
  await act(async () => resolve(messagePage(record)));
  expect(host.textContent).not.toContain("The full ending");
  publicMessage.mockImplementation(async (_task, _id, offset, limit) => messagePage(record, offset, limit));
  await render("task");
  await click("Read full message");
  expect(host.textContent).toContain("The full ending");
});
