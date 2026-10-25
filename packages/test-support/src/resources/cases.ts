// Diagnostic registration wrapper. Keep callbacks, decorators, arguments and outcomes intact.
import type * as Native from "bun:test";
import { format } from "node:util";
import { context, event, type ResourceCase } from "./events.js";

const suites: string[] = [];
const wrappers = new WeakMap<Function, Map<string, Function>>();
const receivers = new WeakMap<object, number>();
let receiverSequence = 0;
function location(): string {
  return new Error().stack?.split("\n").map(line => /(?:\(|at )(.*?\.(?:test|spec)\.tsx?):\d+:\d+\)?$/.exec(line.trim())?.[1]).find(Boolean) ?? (/\.(?:test|spec)\.tsx?$/.test(Bun.main) ? Bun.main : "unattributed");
}
function wrap(raw: Function, kind: "test" | "suite", path: string[] = [], receiver?: object): Function {
  if (receiver && !receivers.has(receiver)) receivers.set(receiver, ++receiverSequence);
  const tag = `${kind}:${path.join("/")}:${receiver ? receivers.get(receiver) : 0}`;
  const cached = wrappers.get(raw)?.get(tag);
  if (cached) return cached;
  const wrapped = function(this: unknown, ...args: unknown[]): unknown {
    if (typeof args[0] === "string" && typeof args[1] === "function") {
      const template = args[0], callback = args[1] as Function, source = location(), suite = [...suites];
      const body = function(this: unknown, ...parameters: unknown[]): unknown {
        if (kind === "suite") { suites.push(path.includes("each") ? format(template, ...parameters) : template); try { return Reflect.apply(callback, this, parameters); } finally { suites.pop(); } }
        const name = path.includes("each") && /%[sdifjoO]/.test(template) ? format(template, ...parameters) : template;
        const owner: ResourceCase = { id: crypto.randomUUID(), file: source, name: [...suite, name].join(" > ") };
        const started = performance.now();
        event({ kind: "case-start", case: owner });
        let finished = false;
        const end = (outcome: string) => { if (!finished) { finished = true; event({ kind: "case-end", case: owner, outcome, wallMs: performance.now() - started }); } };
        return context.run(owner, () => {
          let done = false;
          if (!path.includes("each") && typeof parameters[0] === "function") {
            done = true; const original = parameters[0] as Function;
            parameters[0] = (...values: unknown[]) => { end(values[0] ? "failed" : "passed"); return Reflect.apply(original, undefined, values); };
          }
          try {
            const result = Reflect.apply(callback, this, parameters);
            if (result && typeof result.then === "function") return result.then((value: unknown) => { end("passed"); return value; }, (error: unknown) => { end("failed"); throw error; });
            if (!done) end("passed");
            return result;
          } catch (error) { end("failed"); throw error; }
        });
      };
      Object.defineProperty(body, "length", { value: callback.length });
      args[1] = body;
    }
    const result = Reflect.apply(raw, receiver ?? this, args);
    return typeof result === "function" ? wrap(result, kind, path) : result;
  };
  const known = wrappers.get(raw) ?? new Map<string, Function>(); known.set(tag, wrapped); wrappers.set(raw, known);
  for (const key of new Set([...Object.getOwnPropertyNames(raw), "concurrent", "serial", "each", "skip", "only", "todo", "failing", "if", "skipIf", "todoIf"])) {
    if (["name", "length", "prototype", "arguments", "caller"].includes(key)) continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key), value = Reflect.get(raw, key);
      Object.defineProperty(wrapped, key, { configurable: true, enumerable: descriptor?.enumerable ?? false, value: typeof value === "function" ? wrap(value, kind, [...path, key], raw) : value });
    } catch { /* Native nonconfigurable decorators retain their original behavior. */ }
  }
  return wrapped;
}
export function observedCases(api: typeof Native): Pick<typeof Native, "it" | "test" | "describe"> {
  return { it: wrap(api.it, "test") as typeof Native.it, test: wrap(api.test, "test") as typeof Native.test, describe: wrap(api.describe, "suite") as typeof Native.describe };
}
