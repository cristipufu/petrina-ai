import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { AgentRun } from "../../../src/acp-run.js";
import { CLEANUP_INCOMPLETE } from "../../../src/process-tree.js";
import { AgentBrowser } from "../../../src/browser.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { FAKE_AGENT, removeDir, tempDir, waitFor } from "../../fixtures.js";
import { nativeAgentProcess } from "../../native-agent.js";
import { rejectionOf } from "../../rejections.js";

for (const incomplete of [false, true]) it(`releases native session ownership only after ${incomplete ? "an explicitly failed cleanup remains a failure" : "unexpected exit finishes browser cleanup"}`, async () => {
  const root = tempDir("petrina-probe-ownership-");
  let browser: AgentBrowser | undefined, run: AgentRun | undefined;
  let opening: ReturnType<typeof spyOn<typeof AgentBrowser, "start">> | undefined;
  let closing: ReturnType<typeof spyOn<AgentBrowser, "close">> | undefined;
  let gone: Promise<void> | undefined;
  let closes = 0;
  try {
    browser = await AgentBrowser.start(join(root, "registry"), process.env, undefined, root);
    const close = browser.close.bind(browser);
    closing = spyOn(browser, "close").mockImplementation(async () => {
      closes++;
      if (incomplete) throw new Error("Controlled incomplete browser cleanup");
      await close();
    });
    opening = spyOn(AgentBrowser, "start").mockResolvedValue(browser);
    run = await AgentRun.start({ profile: ENGINE_PROFILES.find(profile => profile.id === "sol-high")!, cwd: root,
      command: [process.execPath, FAKE_AGENT], signal: new AbortController().signal,
      callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" }, onGone: completion => { gone = completion; } });
    expect(gone).toBeDefined();
    if (incomplete) {
      expect(await run.stop()).toBe(false);
      expect(await rejectionOf(gone!)).toMatchObject({ message: CLEANUP_INCOMPLETE });
    } else {
      nativeAgentProcess(run).kill("SIGTERM");
      await waitFor(() => closes === 1, "unexpected exit to initiate owned browser cleanup");
      await gone;
      expect(await run.stop()).toBe(true);
    }
    expect(closes).toBe(1);
  } finally {
    closing?.mockRestore(); opening?.mockRestore();
    await run?.stop();
    await browser?.close();
    removeDir(root);
  }
});
