import { EngineProcess, type EngineProcesses, type EngineStartupOptions } from "../../support.js";
import * as support from "../../support.js";
import * as peers from "../../fixtures/coordinator-process.js";
import type { CommandResult } from "@petrina/test-support/commands";

/** Compile-only API contract: these calls become valid if an unsafe raw entry is restored. */
function rawLaunchesStayUnavailable(home: string, args: readonly string[], options: EngineStartupOptions,
  child: EngineProcess["proc"], hello: EngineProcess["hello"], result: Promise<CommandResult>, controller: AbortController) {
  // @ts-expect-error Every startup must belong to a case owner before its first await.
  EngineProcess.start(home, args, options);
  // @ts-expect-error A harness cannot bypass required case ownership.
  EngineProcess.harness(home, home, home);
  // @ts-expect-error A native spawn cannot bypass the owned command boundary.
  support.spawnEngine(args, home);
  // @ts-expect-error Long-lived stdio peers also require the same case owner.
  peers.coordinatorProcess(home, args);
  // @ts-expect-error Unregistered callback convenience must not bypass the case cleanup collection.
  support.withEngineProcesses(home, async () => {});
  // @ts-expect-error Only the mandatory owned factory may construct a ready process.
  new EngineProcess(child, hello, home, result, controller);
}

function ownedLaunchIsAvailable(owner: EngineProcesses, home: string, args: readonly string[], options: EngineStartupOptions) {
  return owner.app(home, args, options);
}
void rawLaunchesStayUnavailable;
void ownedLaunchIsAvailable;
