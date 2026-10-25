import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TaskDrafts } from "../../../src/drafts";

it("rerenders only the composer while a nonempty draft changes, and keeps independent task drafts", async () => {
  const drafts = new TaskDrafts();
  let parentRenders = 0;
  function Composer() { const text = useSyncExternalStore(drafts.subscribe, () => drafts.get("a")); return <p>{text}</p>; }
  function Workspace() { parentRenders++; const flags = useSyncExternalStore(drafts.subscribe, drafts.presence); return <><span>{Object.keys(flags).join(",")}</span><Composer /></>; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Workspace />));
    await act(async () => drafts.set("a", "First"));
    const renders = parentRenders;
    await act(async () => drafts.set("a", "First draft"));
    expect(parentRenders).toBe(renders); expect(host.querySelector("p")!.textContent).toBe("First draft");
    await act(async () => drafts.set("b", "Another draft"));
    expect(drafts.get("a")).toBe("First draft"); expect(drafts.get("b")).toBe("Another draft");
    await act(async () => drafts.set("a", ""));
    expect(host.querySelector("span")!.textContent).toBe("b"); expect(drafts.get("a")).toBe("");
    const settled = parentRenders;
    await act(async () => drafts.set("a", "")); expect(parentRenders).toBe(settled);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
