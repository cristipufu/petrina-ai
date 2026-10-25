import { launch } from "../../src/launch.js";
import { fixtureEngineOptions } from "../engine.js";
import { recoverBrowserTemps } from "@petrina/agent-runtime/browser";
import { browserProcesses } from "@petrina/platform/browser-processes";

const [home, root] = process.argv.slice(2);
if (!home || !root) throw new Error("The startup-failure fixture needs its private home and browser root");
if (process.argv.includes("--replacement")) process.env.PETRINA_LIFECYCLE_REPLACEMENT = "1";
await launch({ home, mode: "app", loginShell: false, engine: fixtureEngineOptions(home, {
  browser: true, browserTempRoot: root,
  browserRecovery: (registry, browserRoot) => recoverBrowserTemps(registry, browserRoot, undefined, { ...browserProcesses, readFolder: async () => undefined }),
}) });
