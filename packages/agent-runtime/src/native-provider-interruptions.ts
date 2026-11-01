import { RequestError } from "@agentclientprotocol/sdk";
import {
  claudeInterruptions,
  createCodexInterruptions,
  grokInterruptions,
} from "./provider-interruptions.js";

/** Preserve the SDK's actual authentication error at the native boundary. */
export const codexInterruptions = createCodexInterruptions(() => RequestError.authRequired());
export { claudeInterruptions, grokInterruptions };
