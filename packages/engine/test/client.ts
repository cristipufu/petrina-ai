import { EngineClient as ProductionClient, defaultHome } from "../src/engine-client.js";
import { CLI } from "./fixtures.js";

/** The real lifecycle client; an explicit start still uses its existing injection seam. */
export class EngineClient extends ProductionClient {
  constructor(home = defaultHome(), start?: () => number | void) {
    super(home, start, CLI);
  }
}
