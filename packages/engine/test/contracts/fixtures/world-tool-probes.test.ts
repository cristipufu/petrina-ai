import { afterAll, expect, it, spyOn } from "bun:test";
import type { CheckId } from "@petrina/core";
import type { ToolProbe, ToolProbeRequest } from "@petrina/orchestrator";
import { NativeToolProbe } from "../../../src/tool-probe.js";
import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
import { privateWorldToolProbe, worldToolProbe } from "../../fixtures/world-tool-probe.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { FAKE_GH } from "../../fixtures.js";
import { completeAll } from "@petrina/core";
import { expectRejection } from "@petrina/test-support/rejections";

const worlds = nativeWorldFixtures(), nativeWorlds = nativeWorldFixtures({ probes: "native" });
const portfolios = sharedWorldFixtures();
afterAll(() => completeAll([worlds.close(), nativeWorlds.close(), portfolios.close()]));

it("keeps explicit shared-world readiness on the same changing account as its native portfolio CLI", async () => {
  await portfolios.nativeWorld("portfolio-account-probe", async ({ shop, api, engine }) => engine(async current => {
    const native = new NativeToolProbe(current), prepared = privateWorldToolProbe(shop);
    const cleanups: Promise<void>[] = [];
    const request = { signal: current.stopRequested.signal, onGone: (gone: Promise<void>) => { cleanups.push(gone); } };
    try {
      for (const status of ["ready", "logged-out", "unknown", "ready"] as const) {
        request.signal.throwIfAborted();
        shop.setGitHub(state => { state.loggedOut = status === "logged-out"; state.offline = status === "unknown"; });
        const logins = shop.github().logins ?? 0;
        const actual = await native.run("gh", request);
        request.signal.throwIfAborted();
        expect(actual.status).toBe(status);
        expect(await prepared.run("gh", request)).toEqual(actual);
        expect(shop.github().logins).toBe(logins + 2);
        expect(api.github().logins ?? 0).toBe(0);
      }
    } finally {
      await Promise.allSettled(cleanups);
    }
  }));
});

it("uses the same changing private account observations as the native GH probe without launching its CLI", async () => {
  await worlds.world("world-account-parity", async ({ world, engine }) => engine(async current => {
    const probe = current.options.toolProbe!, native = new NativeToolProbe(current);
    const cleanups: Promise<void>[] = [];
    const request = { signal: current.stopRequested.signal, onGone: (gone: Promise<void>) => { cleanups.push(gone); } };
    const spawn = Bun.spawn;
    let launches = 0;
    const watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (Array.isArray(args[0]) && args[0].includes(FAKE_GH)) launches++;
      return Reflect.apply(spawn, Bun, args);
    }) as typeof Bun.spawn);
    try {
      expect(probe.absent("gh")).toBe(false);
      for (const status of ["ready", "logged-out", "unknown", "ready"] as const) {
        world.setGitHub(state => { state.loggedOut = status === "logged-out"; state.offline = status === "unknown"; });
        const before = launches, logins = world.github().logins ?? 0;
        const observed = await native.run("gh", request);
        expect(observed.status).toBe(status); expect(launches).toBe(before + 1);
        expect(await probe.run("gh", request)).toEqual(observed);
        expect(launches).toBe(before + 1); expect(world.github().logins).toBe(logins + 2);
        expect(world.github().calls).toEqual([]);
      }
      const stop = new AbortController(); stop.abort();
      const logins = world.github().logins;
      await expectRejection(probe.run("gh", { ...request, signal: stop.signal }));
      expect(world.github().logins).toBe(logins);
    } finally {
      watch.mockRestore();
      await Promise.allSettled(cleanups);
    }
  }));
});

it("preserves every non-GH native observation and its stop callback, including missing and inconclusive tools", async () => {
  const calls: { id: CheckId; request: ToolProbeRequest }[] = [];
  const absent: CheckId[] = [];
  const cleanups: Promise<void>[] = [];
  const native: ToolProbe = {
    absent(id) { absent.push(id); return id === "antigravity"; },
    async run(id, request) { calls.push({ id, request }); return id === "antigravity" ? { status: "not-installed" } : { status: "unknown", detail: `Explicit ${id} observation` }; },
  };
  const probe = worldToolProbe("unused-state", "unused-remote", () => native);
  const request = { signal: new AbortController().signal, onGone: (gone: Promise<void>) => { cleanups.push(gone); } };
  try {
    for (const id of ["git", "claude-code", "codex", "grok", "antigravity"] as const) {
      expect(probe.absent(id)).toBe(id === "antigravity");
      expect(await probe.run(id, request)).toEqual(id === "antigravity" ? { status: "not-installed" } : { status: "unknown", detail: `Explicit ${id} observation` });
      expect(calls.at(-1)).toEqual({ id, request }); expect(calls.at(-1)!.request).toBe(request);
    }
    expect(absent).toEqual(["git", "claude-code", "codex", "grok", "antigravity"]);
  } finally {
    await Promise.allSettled(cleanups);
  }
});

it("keeps native probe opt-ins and explicit command or probe overrides", async () => {
  await nativeWorlds.world("world-native-probes", async ({ engine }) => engine(async current => {
    expect(current.options.toolProbe).toBeUndefined();
  }));
  await worlds.world("world-probe-overrides", async ({ engine }) => {
    const probe = scriptedToolProbe({ gh: { status: "logged-out" } });
    await engine(async current => { expect(current.options.toolProbe).toBe(probe); }, { toolProbe: probe });
    await engine(async current => { expect(current.options.toolProbe).toBeUndefined(); expect(current.options.gh).toEqual(["explicit-native-command"]); }, { gh: ["explicit-native-command"] });
    await engine(async current => {
      expect(current.options.toolProbe).toBeUndefined(); expect(current.options.github).toBeUndefined();
      const native = new NativeToolProbe(current);
      const cleanups: Promise<void>[] = [];
      try {
        expect(native.absent("gh")).toBe(true);
        expect(await native.run("gh", { signal: current.stopRequested.signal, onGone: (gone) => { cleanups.push(gone); } })).toEqual({ status: "not-installed" });
      } finally {
        await Promise.allSettled(cleanups);
      }
    }, { gh: undefined, which: () => null });
    await engine(async current => { expect(current.options.toolProbe).toBeUndefined(); }, { toolProbe: undefined });
    await engine(async current => { expect(current.options.toolProbe).toBeUndefined(); }, { toolCheckTimeoutMs: 1 });
  });
});
