// An app-mode engine on fake agents and a fake GitHub, started the way the desktop shell starts
// one: tests talk to it over its stdin and stdout, quit it by closing stdin, or kill it.
// bun harness.ts <petrina folder> <fake dir>
import { join } from "node:path";
import { launch } from "../src/launch.js";

const [home, dir] = process.argv.slice(2);
await launch({
  home: home!,
  mode: "app",
  loginShell: false,
  engine: {
    agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), dir!],
    gh: [process.execPath, join(import.meta.dir, "fake-gh.ts"), join(dir!, "github.json")],
    // Tests never open a real terminal window.
    terminals: () => [],
  },
});
