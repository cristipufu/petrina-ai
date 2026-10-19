// An app-mode engine on fake agents and a fake GitHub, started the way the desktop shell starts
// one: tests talk to it over its stdin and stdout, quit it by closing stdin, or kill it.
// bun harness.ts <petrina folder> <fake dir> [folder standing in for GitHub]
// The stand-ins reach Petrina only through the Engine's constructor.
import { join } from "node:path";
import { launch } from "../src/launch.js";

const [home, dir, remote] = process.argv.slice(2);
await launch({
  home: home!,
  mode: "app",
  newKey: process.argv.includes("--new-key"),
  loginShell: false,
  engine: {
    agentCommand: (profile) => [process.execPath, join(import.meta.dir, "fake-agent.ts"), dir!, `--script=${join(dir!, "agents.json")}`, `--record-tool=${profile.toolId}`],
    gh: [process.execPath, join(import.meta.dir, "fake-gh.ts"), join(dir!, "github.json"), remote ?? join(dir!, "github.git")],
    ...(remote ? { remote } : {}),
    // Tests never open a real terminal window.
    terminals: () => [],
  },
});
