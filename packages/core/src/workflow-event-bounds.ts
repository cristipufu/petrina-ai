import type { WorkflowEvent } from "./workflow-events.js";

export const WORKFLOW_EVENT_BYTES = 8 * 1024;

export function boundWorkflowEvent(event: WorkflowEvent, encoded: (value: unknown) => number, limit = WORKFLOW_EVENT_BYTES): WorkflowEvent {
  const shortened = new Set<string>();
  const totals: Record<string, number> = {};
  let bounded: WorkflowEvent = { ...event, refs: { ...event.refs, details: { eventId: event.id } } };
  const trim = (key: string, keep: number) => {
    const value = bounded[key];
    if (Array.isArray(value) && value.length > keep) {
      totals[key] ??= value.length;
      bounded = { ...bounded, [key]: value.slice(0, keep) };
      shortened.add(key);
    }
  };
  for (const key of [
    "products",
    "raised",
    "fixed",
    "claimedFixed",
    "reopened",
    "dismissed",
    "unverified",
    "stillOpen",
    "openImportant",
    "openNits",
    "openPreExisting",
    "heldForDecision",
    "reports",
    "findingIds"
  ]) trim(
    key,
    20
  );
  for (const key of ["summary", "reason", "detail", "answer", "title", "error"]) {
    const value = bounded[key];
    if (typeof value === "string" && value.length > 400) {
      bounded = { ...bounded, [key]: `${value.slice(0, 399)}…` };
      shortened.add(key);
    }
  }
  if (bounded.cause?.reason && bounded.cause.reason.length > 400) {
    bounded = { ...bounded, cause: { ...bounded.cause, reason: `${bounded.cause.reason.slice(0, 399)}…` } };
    shortened.add("cause.reason");
  }
  const result = () => ({
    ...bounded,
    ...(shortened.size ? {
    shortened: true,
    shortenedFields: [...shortened],
    ...(Object.keys(totals).length ? { totals } : {})
  } : {})
  });
  // Descriptions are supplemental: preserve the existing identity lists before shortening them.
  // The core orders outstanding reports first, so the descriptions kept here explain remaining work.
  const reports = bounded.reports;
  if (Array.isArray(reports)) for (let keep = reports.length - 1; keep >= 0 && encoded(result()) > limit; keep--) trim("reports", keep);
  if (encoded(result()) <= limit) return result();
  for (const [key, keep] of [
    [
    "manifest",
    4
  ],
    [
    "products",
    4
  ],
    [
    "raised",
    5
  ],
    [
    "fixed",
    5
  ],
    [
    "claimedFixed",
    5
  ],
    [
    "reopened",
    5
  ],
    [
    "dismissed",
    5
  ],
    [
    "unverified",
    5
  ],
    [
    "stillOpen",
    5
  ],
    [
    "openImportant",
    5
  ],
    [
    "openNits",
    5
  ],
    [
    "openPreExisting",
    5
  ],
    [
    "heldForDecision",
    5
  ],
    [
    "reports",
    5
  ],
    [
    "findingIds",
    5
  ],
    [
    "team",
    6
  ],
    [
    "seats",
    6
  ],
    [
    "waitsOn",
    4
  ],
    [
    "productIds",
    8
  ]
  ] as const) trim(
    key,
    keep
  );
  if (encoded(result()) <= limit) return result();
  // Preserve the transition and its identity. Complete compact details share the bounded log and have
  // their own paged read; no oversized nested explanation or reference can defeat this last size check.
  const { id, seq, run, at, kind, taskId, productId, nodeId, seat, attempt, summary } = bounded;
  shortened.add("details");
  bounded = {
    id,
    seq,
    run,
    at,
    kind,
    taskId,
    productIds: bounded.productIds.slice(
    0,
    8
  ),
    ...(productId ? { productId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(seat ? { seat } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    summary,
    refs: { details: { eventId: id } }
  };
  if (encoded(result()) <= limit) return result();
  // Identifiers come from the bounded command schemas. This minimal envelope fits even with every
  // optional identifier and Unicode summary at their largest; oversized lists remain on the detail page.
  return {
    id,
    seq,
    run,
    at,
    kind,
    taskId,
    productIds: [],
    summary: summary.slice(
    0,
    200
  ),
    refs: { details: { eventId: id } },
    shortened: true,
    shortenedFields: [
    "details",
    "productIds"
  ]
  };
}
