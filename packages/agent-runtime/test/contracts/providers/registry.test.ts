import { expect, it } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { ADAPTERS } from "../../../src/tools.js";
import { air } from "../../fixtures/provider-envelopes.js";

it("keeps unsupported interruptions absent and supplies the real SDK authentication error", () => {
    expect(ADAPTERS.antigravity!.interruptions).toBeUndefined();
  const error = ADAPTERS.codex!.interruptions!.failure!({ stopReason: "end_turn", _meta: air("access", "error", "Login required", ["login"]) });
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).code).toBe(-32000);
});
