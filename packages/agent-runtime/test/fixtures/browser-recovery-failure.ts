// A private native owner process: only this attempted recovery sees unavailable observations.
import { existsSync, readdirSync } from "node:fs";
import { recoverBrowserTemps } from "../../src/browser.js";
import { browserProcesses } from "@petrina/platform/browser-processes";
const [registry, browsers] = process.argv.slice(2) as [string, string];
try {
  await recoverBrowserTemps(registry, browsers, undefined, { ...browserProcesses, readFolder: async () => undefined });
  console.log(JSON.stringify({ failed: false }));
} catch (error) {
  console.log(JSON.stringify({ failed: true, message: (error as Error).message, folder: readdirSync(registry).length, marker: existsSync(registry) }));
}
