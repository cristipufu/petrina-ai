

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckAgain, ToolList, useCheckOnEnter } from "../../../src/components/Tools";

const { checkTools } = vi.hoisted(() => ({ checkTools: vi.fn() }));

vi.mock("../../../src/engine", () => ({ desktop: false, mode: "engine", sim: { checkTools } }));

let root: Root | undefined;

let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove(); root = undefined; host = undefined; checkTools.mockClear();
});

function Screen({ active }: { active: boolean }) {
  useCheckOnEnter(active);
  return <CheckAgain checks={[]} />;
}

async function render(active: boolean) {
  if (!host) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<StrictMode><Screen active={active} /></StrictMode>));
}

describe("Tools readiness checks", () => {
  it("checks on entry and explicit retry, ignoring updates, focus, visibility and elapsed time", async () => {
    await render(false);
    expect(checkTools).not.toHaveBeenCalled();
    await render(true);
    expect(checkTools).toHaveBeenCalledTimes(1);
    const future = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await render(true);
      expect(checkTools).toHaveBeenCalledTimes(1);
      await act(async () => host!.querySelector("button")!.click());
      expect(checkTools).toHaveBeenCalledTimes(2);
      await render(false); await render(true);
      expect(checkTools).toHaveBeenCalledTimes(3);
    } finally { future.mockRestore(); }
  });

  it("shows the actual uncertain error without prescribing a new login", async () => {
    await render(false);
    await act(async () => root!.render(<ToolList platform="darwin" checks={[{ id: "antigravity", status: "unknown", detail: "Antigravity did not answer within 8 seconds." }]} />));
    expect(host!.textContent).toContain("Check again");
    expect(host!.textContent).not.toContain("log in again");
    expect(host!.querySelector(".command")).toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>("button")!.click());
    expect(host!.textContent).toContain("Antigravity did not answer within 8 seconds.");
    await act(async () => root!.render(<ToolList platform="darwin" checks={[{ id: "antigravity", status: "logged-out" }]} />));
    expect(host!.textContent).toContain("bun run petrina antigravity login");
  });
});
