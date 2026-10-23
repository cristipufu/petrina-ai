// Separate engine process, killed by the recovery controls rather than an orderly shutdown.
import { Engine } from "./engine.js";
import { readFileSync } from "node:fs";
import type { EngineOptions } from "./engine.js";
const [data, settings] = process.argv.slice(2);
const options = JSON.parse(readFileSync(settings!, "utf8")) as EngineOptions;
const engine = new Engine(data!, { ...options, agentCommand: () => { throw new Error("Extra-validation controls must not start agents"); }, awakeObserver: () => {} });
engine.setPoolPaused(false);
await new Promise(() => {});
