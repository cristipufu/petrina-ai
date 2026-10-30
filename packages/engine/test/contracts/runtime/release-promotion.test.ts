import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { EngineClient } from "../../client.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import { Fakes, HARNESS, removeDir, SLOW, tempDir, waitFor } from "../../support.js";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { ReleaseStore, validateReleaseVersion } from "../../../src/release-store.js";
import type { LifecycleTransitionAction } from "../../../src/release-transition.js";

const roots: string[] = [];
const apiOwners = coordinatorApiFixtures();
const lifetimes = coordinatorLifetimes();

afterEach(() => lifetimes.close());
afterAll(async () => {
  await apiOwners.close();
  for (const root of roots) {
    if (!lifetimes.retained.has(root)) removeDir(root);
  }
});

describe("atomic versioned engine release promotion and rollback", () => {
  it("validates release identifiers, stages immutable artifacts, and supports offline promote and rollback", async () => {
    const root = tempDir("petrina-release-store-");
    roots.push(root);
    const home = join(root, "home");
    const srcDir = join(root, "artifacts");
    const store = new ReleaseStore(home);

    expect(() => validateReleaseVersion("")).toThrow();
    expect(() => validateReleaseVersion("../evil")).toThrow();
    expect(() => validateReleaseVersion(".hidden")).toThrow();
    expect(() => validateReleaseVersion("1.0.0/extra")).toThrow();

    const v1Src = join(root, "v1.ts");
    const v2Src = join(root, "v2.ts");
    writeFileSync(v1Src, "// engine 1.0.0\n");
    writeFileSync(v2Src, "// engine 1.1.0\n");
    expect(existsSync(srcDir)).toBe(false);

    const stagedV1 = store.stage("1.0.0", v1Src);
    expect(stagedV1.kind).toBe("bun");
    expect(existsSync(stagedV1.entrypoint)).toBe(true);
    expect(() => store.stage("1.0.0", v1Src)).toThrow(/already staged/);

    const client = new EngineClient(home);
    const offlinePromote1 = await client.call("engine.promote", {
      requestId: "offline-promote-v1",
      version: "1.0.0",
    });
    expect(offlinePromote1.outcome).toBe("completed");
    expect(store.readCurrent()?.version).toBe("1.0.0");
    expect(store.readPrevious()).toBeNull();

    const offlinePromote2 = await client.call("engine.promote", {
      requestId: "offline-promote-v2",
      version: "1.1.0",
      sourcePath: v2Src,
    });
    expect(offlinePromote2.outcome).toBe("completed");
    // Idempotent replay with same requestId returns identical receipt.
    const replay = await client.call("engine.promote", {
      requestId: "offline-promote-v2",
      version: "1.1.0",
      sourcePath: v2Src,
    });
    expect(replay.outcome).toBe("completed");

    const catalog = await client.call("engine.releases");
    expect(catalog.outcome).toBe("completed");
    expect((catalog.current as { version: string }).version).toBe("1.1.0");
    expect((catalog.previous as { version: string }).version).toBe("1.0.0");
    expect((catalog.versions as { version: string }[]).map((entry) => entry.version)).toEqual(["1.0.0", "1.1.0"]);

    const rolledBack = await client.call("engine.rollback", {
      requestId: "offline-rollback-v1",
    });
    expect(rolledBack.outcome).toBe("completed");
    expect(store.readCurrent()?.version).toBe("1.0.0");
  });

  it("stages candidate pre-drain and waits for active turns to drain before promoting", async () => {
    return apiOwners.use(async ({ e, home, taskId, owner: lifetime }) => {
      await Promise.all([...e.backgroundWork]);
      const candidateFile = join(home, "candidate-1.1.0.ts");
      writeFileSync(candidateFile, "// candidate 1.1.0\n");

      let releaseTurn!: () => void;
      const activeTurn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      e.settling.set(taskId, activeTurn);
      const t = e.task(taskId)!;
      t.state = "running";
      t.holdsSlot = true;
      t.agent = { roleId: "builder", profileId: "opus-high", since: Date.now(), step: 0 };
      lifetime.onStop(() => {
        releaseTurn();
        e.settling.delete(taskId);
      });
      lifetime.check();

      const store = new LifecycleStore(home);
      const closeStore = lifetime.afterBody(() => store.close());
      const transitions: LifecycleTransitionAction[] = [];
      const life = new EngineLifecycle(e, store, async (_restart, action) => {
        if (action) transitions.push(action);
        store.finish("completed");
      });
      lifetime.onStop(() => life.close());

      try {
        const res = await life.request("promote", {
          requestId: "drain-before-promote",
          version: "1.1.0",
          sourcePath: candidateFile,
        });
        expect(res.outcome).toBe("pending");
        expect(transitions).toHaveLength(0);
        const releaseStore = new ReleaseStore(home);
        expect(releaseStore.hasVersion("1.1.0")).toBe(true);
        // Active pointer does not flip until active turns finish draining.
        expect(releaseStore.readCurrent()).toBeNull();

        t.holdsSlot = false;
        delete t.agent;
        t.state = "queued";
        e.settling.delete(taskId);
        releaseTurn();

        await waitFor(() => transitions.length === 1, "drained promote transition");
        expect(transitions[0]).toEqual({ kind: "promote", version: "1.1.0" });
      } finally {
        releaseTurn();
        life.close();
        await closeStore();
        e.settling.delete(taskId);
      }
    });
  });

  it("promotes a live engine to a new release and automatically rolls back when a broken release fails startup", async () => {
    const root = tempDir("petrina-live-promote-");
    roots.push(root);
    let pendingStore: LifecycleStore | undefined;
    const closeStore = () => {
      pendingStore?.close();
      pendingStore = undefined;
    };
    const lifetime = await lifetimes.open(root, {
      async stopPeers() {
        await completeAll([Promise.resolve().then(closeStore)]);
      },
    });
    let cleanup: (() => Promise<void>) | undefined;
    const close = async () => {
      await setupWithCleanup(
        async () => {
          await cleanup?.();
        },
        () => lifetime.close(),
      );
      await lifetime.close();
    };

    await setupWithCleanup(
      () =>
        lifetime.prepare(async () => {
          await lifetime.ready;
          const home = join(root, "home");
          const fakes = new Fakes(join(root, "agents"));
          fakes.scenario({ controlled: true });
          const markerFile = join(root, "booted-versions.log");

          const v1Program = lifetime.program(
            "release-1.0.0.ts",
            `require("node:fs").appendFileSync(${JSON.stringify(markerFile)}, "1.0.0\\n");\nawait import(${JSON.stringify(HARNESS)});`,
          );
          const v11Program = lifetime.program(
            "release-1.1.0.ts",
            `require("node:fs").appendFileSync(${JSON.stringify(markerFile)}, "1.1.0\\n");\nawait import(${JSON.stringify(HARNESS)});`,
          );
          const brokenProgram = lifetime.program(
            "release-2.0.0-broken.ts",
            `require("node:fs").appendFileSync(${JSON.stringify(markerFile)}, "2.0.0-broken\\n");\nprocess.exit(1);`,
          );

          const releaseStore = new ReleaseStore(home);
          releaseStore.stage("1.0.0", v1Program);
          const initialPromoted = releaseStore.promote("1.0.0");

          const initial = await lifetime.harness(home, fakes.dir, undefined, {
            entry: initialPromoted.current.entrypoint,
          });
          const client = new EngineClient(home);

          cleanup = async () => {
            try {
              await lifetime.prepare(() =>
                client.call("engine.stop", {
                  requestId: "stop-after-promotion-test",
                  wait: true,
                  timeoutMs: 10_000 * SLOW,
                }),
              );
            } finally {
              await lifetime.close();
            }
            await initial.exited(10_000 * SLOW);
          };

          // 1. Live promote 1.0.0 -> 1.1.0
          const promoted = await client.call("engine.promote", {
            requestId: "live-promote-1-1-0",
            version: "1.1.0",
            sourcePath: v11Program,
            wait: true,
            timeoutMs: 15_000 * SLOW,
          });
          expect(promoted.outcome).toBe("completed");
          expect(await initial.exited(10_000 * SLOW)).toBe(0);

          const releasesAfterV11 = await client.call("engine.releases");
          expect((releasesAfterV11.current as { version: string }).version).toBe("1.1.0");
          expect((releasesAfterV11.previous as { version: string }).version).toBe("1.0.0");

          // 2. Live promote 1.1.0 -> 2.0.0-broken: candidate crashes before /health, auto-rollback restores 1.1.0
          const failedPromote = await client.call("engine.promote", {
            requestId: "live-promote-2-0-0-broken",
            version: "2.0.0-broken",
            sourcePath: brokenProgram,
            wait: true,
            timeoutMs: 15_000 * SLOW,
          });
          expect(failedPromote.outcome).toBe("failed");
          expect(String(failedPromote.message ?? "")).toContain("automatically rolled back to 1.1.0");

          const releasesAfterRollback = await client.call("engine.releases");
          expect((releasesAfterRollback.current as { version: string }).version).toBe("1.1.0");

          const liveStatus = await client.call("engine.status");
          expect(liveStatus.outcome).toBe("completed");
          expect(liveStatus.status).toBe("running");
          expect((liveStatus.operation as { kind: string; version: string }).kind).toBe("rollback");
          expect((liveStatus.operation as { kind: string; version: string }).version).toBe("1.1.0");

          const boots = readFileSync(markerFile, "utf8").trim().split("\n");
          expect(boots).toEqual(["1.0.0", "1.1.0", "2.0.0-broken", "1.1.0"]);
        }),
      close,
    );
    await close();
  });
});
