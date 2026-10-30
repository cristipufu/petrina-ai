// An app-mode engine on fake agents and a fake GitHub, started the way the desktop shell starts
// one: tests talk to it over its stdin and stdout, quit it by closing stdin, or kill it.
// bun harness.ts <petrina folder> <fake dir> [folder standing in for GitHub] [--browser-root=<folder>]
// The stand-ins reach Petrina only through the Engine's constructor. Fake agents get no browser
// unless the test supplies its own parent for their browser folders, which recovery uses too.
import { join } from "node:path";
import { launch } from "../src/launch.js";
import { Engine, fixtureEngineOptions } from "./engine.js";
import { observeHarnessGitHub } from "./fixtures/harness-github.js";
import { installSharedWorkflowFastPaths } from "./fixtures/shared-preparation.js";
import { privateWorldToolProbe } from "./fixtures/world-tool-probe.js";

const [home, dir, remote] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const agentProgram = process.argv.find(arg => arg.startsWith("--agent-program="))?.slice("--agent-program=".length);
const githubProgram = process.argv.find(arg => arg.startsWith("--gh-program="))?.slice("--gh-program=".length);
const githubRegistrationGate = process.argv.find(arg => arg.startsWith("--gh-registration-gate="))?.slice("--gh-registration-gate=".length);
const browserTempRoot = process.argv.find((arg) => arg.startsWith("--browser-root="))?.slice("--browser-root=".length);
if (!githubProgram) throw new Error("The app-mode fixture needs an owned GitHub program. Use its owner's harness or harnessArgs.");
observeHarnessGitHub(githubProgram, githubRegistrationGate);
if (process.argv.includes("--fast-workflow")) {
  const rawWait = Engine.prototype.waitUntilReady;
  Engine.prototype.waitUntilReady = function() {
    installSharedWorkflowFastPaths(this, { skipDriverPrepare: false, skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCheckpoints: true });
    return rawWait.call(this);
  };
}
await launch({
  home: home!,
  mode: "app",
  newKey: process.argv.includes("--new-key"),
  loginShell: false,
  engine: fixtureEngineOptions(home!, {
    toolProbe: privateWorldToolProbe({ dir: dir!, remote: remote ?? join(dir!, "github.git") }),
    agentCommand: (profile) => [process.execPath, agentProgram ?? join(import.meta.dir, "fake-agent.ts"), dir!, `--script=${join(dir!, "agents.json")}`, `--record-tool=${profile.toolId}`, ...(process.argv.includes("--stubborn") ? ["--stubborn"] : [])],
    gh: [process.execPath, githubProgram, join(dir!, "github.json"), remote ?? join(dir!, "github.git")],
    ...(remote ? { remote } : {}),
    ...(browserTempRoot ? { browser: true, browserTempRoot } : {}),
  }),
});
