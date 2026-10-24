import type { DeepMutable } from "../../src/flow.js";
import type { Finding } from "../../src/model.js";

export const finding = (id: string, extra: Partial<DeepMutable<Finding>> = {}): DeepMutable<Finding> =>
  ({ id, text: `Finding ${id}`, severity: "blocking", raisedBy: "sol-xhigh", confirmedBy: [], status: "open", ...extra });
