import { afterAll, describe, expect, it } from "bun:test";
import { LifecycleStore } from "../../../src/lifecycle-store.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("graceful coordination lifecycle", () => {
it("does not let a stale old-owner observation overwrite a starting or ready replacement", () => {
    const root = tempDir("petrina-lifecycle-observation-");
    roots.push(root);
    const store = new LifecycleStore(root);
    try {
      store.begin("restart", { requestId: "handoff" }, "running");
      store.finish("stopping");
      const observed = store.current!;
      store.finish("starting");
      expect(store.failIfUnchanged(observed, "old owner exited")).toBe(false);
      const starting = store.current!;
      store.finish("completed");
      expect(store.failIfUnchanged(starting, "launcher exited")).toBe(false);
      expect(store.receipt("handoff")!.outcome).toBe("completed");
    } finally {
      store.close();
    }
  });
});
for (const kind of ["pause", "restart"]) {
it(`a disconnected ${kind} follower cannot reserve a new effect after the observed operation changes`, () => {
  const home = tempDir("petrina-raced-lifecycle-follower-");
  roots.push(home);
  const store = new LifecycleStore(home);
  try {
    store.begin(kind, { requestId: "observed" }, "paused");
    const observed = store.current!;
    expect(store.follow(kind, { requestId: "following" }, observed).outcome).toBe("pending");
    store.finish("completed");
    store.begin("resume", { requestId: "unrelated-control" }, "running");
    store.finish("completed");
    expect(store.follow(kind, { requestId: "raced-follower" }, observed).outcome).toBe("disconnected");
    expect(store.receipt("raced-follower")).toBeUndefined();
    expect(store.current!.id).toBe("unrelated-control");
    expect(store.follow(kind, { requestId: "following" }, observed).outcome).toBe("completed");
    expect(store.follow("stop", { requestId: "following" }, observed).outcome).toBe("conflict");
  } finally { store.close(); }
});
}
for (const ending of ["completed", "failed"] as const) {
it(`persists ${ending} for restart followers through a lost reply and reopening the receipt store`, () => {
  const home = tempDir("petrina-lifecycle-followers-");
  roots.push(home);
  let store = new LifecycleStore(home);
  try {
    store.begin("restart", { requestId: "original" }, "paused");
    store.begin("restart", { requestId: "following" }, "paused");
    store.finish("starting");
    store.finish(ending, ending === "failed" ? "Startup failed" : undefined);
    store.close(); store = new LifecycleStore(home);
    const followed = store.begin("restart", { requestId: "following" }, "paused");
    expect(followed.outcome).toBe(ending);
    expect(followed.requestId).toBe("following");
    expect(followed.operation).toHaveProperty("phase", ending);
    expect(followed.operation).toHaveProperty("id", "original");
  } finally { store.close(); }
});
}
