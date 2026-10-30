import { RequestError } from "@agentclientprotocol/sdk";
import { createProviderInterruptions } from "./provider-interruptions.js";

/** Preserve the SDK's actual authentication error at the native boundary. */
export const {
  codex: codexInterruptions,
  claude: claudeInterruptions,
  grok: grokInterruptions
} = createProviderInterruptions(() => RequestError.authRequired());
