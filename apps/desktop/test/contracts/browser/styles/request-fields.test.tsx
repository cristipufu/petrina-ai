import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CombineBacklog } from "../../../../src/components/CombineBacklog";
import { NewTaskDialog } from "../../../../src/components/NewTask";
import { FirstRun } from "../../../../src/components/FirstRun";
import { applyTheme } from "../../../../src/theme";
import { inkTheme } from "../../../../src/themes";
import { stateFixture, taskFixture } from "../../../fixtures/state";
import { readAppStyles } from "../../../fixtures/styles";

vi.mock("../../../../src/engine", () => ({
  mode: "demo",
  sim: { checkTools: () => {}, findClones: async () => [] },
  failureText: (error: Error) => error.message,
}));

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

beforeEach(() => {
  localStorage.clear();
  applyTheme(inkTheme);
  style = document.createElement("style");
  style.textContent = readAppStyles();
  document.head.append(style);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  style.remove();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeId;
});

for (const surface of ["combine", "new task", "first task"] as const) {
  it(`keeps the ${surface} title boxed with a bold label`, async () => {
    const state = stateFixture();
    state.tasks = [taskFixture(state, { id: "one" }), taskFixture(state, { id: "two" })];
    state.setup = { done: false, step: "task", platform: "darwin", checks: [] };
    await act(async () => root.render(surface === "combine"
      ? <CombineBacklog state={state} tasks={state.tasks} onClose={() => {}} onCreated={() => {}} />
      : surface === "new task" ? <NewTaskDialog state={state} onClose={() => {}} onCreated={() => {}} />
      : <FirstRun state={state} status={{ link: "live", desktop: false, synced: true }} />));
    const title = host.querySelector<HTMLInputElement>(".title-input")!;
    title.blur();
    const field = getComputedStyle(title);
    expect(field.borderTopStyle).toBe("solid");
    expect(field.borderTopWidth).toBe("1px");
    expect(field.paddingTop).toBe("12px");
    expect(field.borderRadius).toBe("8px");
    expect(field.fontWeight).toBe("500");
    const label = getComputedStyle(host.querySelector(`label[for="${title.id}"]`)!);
    expect(label.fontWeight).toBe("600");
    expect(label.display).toBe("flex");
  });
}

for (const count of [1, 2]) {
  it(`keeps Product quiet and inline with ${count} product choices`, async () => {
    const state = stateFixture();
    state.products = state.products.slice(0, count);
    state.setup = { done: false, step: "task", platform: "darwin", checks: [] };
    await act(async () => root.render(<FirstRun state={state} status={{ link: "live", desktop: false, synced: true }} />));
    const row = host.querySelector(".setup-product")!;
    expect(getComputedStyle(row).display).toBe("flex");
    expect(getComputedStyle(row.querySelector("span")!).fontWeight).toBe("400");
    if (count > 1) {
      const control = getComputedStyle(row.querySelector(".select-control")!);
      expect(control.flexGrow).toBe("1");
      expect(control.width).toBe("auto");
    }
  });
}
