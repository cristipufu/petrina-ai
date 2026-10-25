import { checkOf, type CheckId, type ToolCheck } from "@petrina/core";
import { ControlledClock } from "./clock.js";
import { ToolCheckCoordinator, type ToolProbe, type ToolProbeRequest, type ToolProbeResult } from "../../src/index.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function toolCheckFixture() {
  const scripts = new Map<CheckId, (request: ToolProbeRequest) => ToolProbeResult | Promise<ToolProbeResult>>();
  const missing = new Set<CheckId>(), checks = new Map<CheckId, ToolCheck>();
  const calls: { id: CheckId; request: ToolProbeRequest }[] = [], published: ToolCheck[] = [];
  const clock = new ControlledClock();
  const events = { publish: (_check: ToolCheck) => {} };
  let stopped = false;
  const probe: ToolProbe = {
    absent: id => missing.has(id),
    async run(id, request) {
      calls.push({ id, request });
      const script = scripts.get(id);
      if (!script) throw new Error(`Unexpected probe: ${id}`);
      return script(request);
    },
  };
  const coordinator = new ToolCheckCoordinator({ stopped: () => stopped, current: id => checkOf([...checks.values()], id),
    publish(check) { checks.set(check.id, structuredClone(check)); published.push(structuredClone(check)); events.publish(check); },
  }, probe, clock);
  return { coordinator, probe, scripts, missing, checks, calls, published, clock, events,
    stopHost: () => { stopped = true; }, result: (id: CheckId) => checks.get(id) };
}
