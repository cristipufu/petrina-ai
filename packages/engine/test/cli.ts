// Exercise the real parser and launcher with the same fixture policy as every other test engine.
import { runCli } from "../src/cli.js";
import { launch } from "../src/launch.js";
import { fixtureEngineOptions } from "./engine.js";
import { EngineClient } from "./client.js";

await runCli(process.argv.slice(2), options => launch({
  ...options,
  loginShell: false,
  engine: fixtureEngineOptions(options.home, options.engine),
}), new EngineClient());
