import { afterEach, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { CLEANUP_NOTE } from "../../../src/browser.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import { rejectionOf } from "@petrina/test-support/rejections";
import { SLOW } from "@petrina/test-support/slow";
import { browserCleanupFixtures } from "../../fixtures/browser-cleanup-owned.js";

const fixtures = browserCleanupFixtures();
afterEach(() => fixtures.close());

it.skipIf(process.platform === "win32")("reports the private unused-browser cleanup note through the actual ACP owner and retains its folder until independent cleanup", async () => fixtures.use(async fixture => {
  const opened = await fixture.open({ browser: true });
  expect(opened.kind).toBe("value");
  if (opened.kind !== "value") throw opened.error;
  expect(await opened.value.stop()).toBe(false);
  expect(fixture.incomplete).toBe(1);
  expect(fixture.gone).toBeDefined();
  expect((await rejectionOf(fixture.gone!) as Error).message).toBe(CLEANUP_INCOMPLETE);
  const notes = fixture.logs.join("").split("\n").filter(line => line.includes(CLEANUP_NOTE));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(new RegExp(`^${CLEANUP_NOTE} stage=exited-before-close elapsed=\\d+ms helper=signal-SIGKILL,closed,unused early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0$`));
  expect(existsSync(fixture.browser!.directory)).toBe(true);
  expect(readdirSync(fixture.registry)).toHaveLength(1);
  await fixture.ended();
  fixture.restoreScans();
  await fixture.browser!.close();
  expect(existsSync(fixture.browser!.directory)).toBe(false);
  expect(readdirSync(fixture.registry)).toEqual([]);
  expect(await opened.value.stop()).toBe(false);
  expect(fixture.incomplete).toBe(1);
}), 90_000 * SLOW);
