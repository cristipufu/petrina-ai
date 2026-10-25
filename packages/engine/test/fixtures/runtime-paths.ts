import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The canonical application fixture actors live here; moved cases keep that owned anchor. */
export const ENGINE_TEST_ROOT = dirname(fileURLToPath(new URL("../fixtures.ts", import.meta.url)));
