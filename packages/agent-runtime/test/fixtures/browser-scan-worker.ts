import { existsSync, readdirSync } from "node:fs";
import { AgentBrowser } from "../../src/browser.js";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { connectBrowser } from "./browser-client.js";

const [registry, root, record] = process.argv.slice(2);
if (!registry || !root || !record) throw new Error("The native browser scan control needs its private registry, root and record");
let unavailable = false;
const browser = await AgentBrowser.start(registry, process.env, undefined, root, {
  ...browserProcesses, readFolder: directory => unavailable ? Promise.resolve(undefined) : browserProcesses.readFolder(directory),
});
const child = browser["child"], client = await connectBrowser(browser);
let result;
try {
  const opened = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
  if (opened.isError) throw new Error(JSON.stringify(opened));
  if (child.pid === undefined) throw new Error("The browser control has no owned helper");
  const owned = await browserProcesses.descendantsKnown([child.pid], 3_200);
  if (!owned?.length) throw new Error("The opened browser has no recorded children");
  writeFixtureJson(record, owned);
  await client.close();
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGKILL"); await exited;
  unavailable = true;
  let error;
  try { await browser.close(); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  result = { error, keptDirectory: existsSync(browser.directory), registrations: readdirSync(registry).length };
} finally {
  unavailable = false;
  await client.close().catch(() => undefined);
  await browser.close();
}
console.log(JSON.stringify({ ...result, removedAfterRetry: !existsSync(browser.directory), registrationsAfterRetry: readdirSync(registry).length }));
