import type { QueuedMessage } from "./model.js";

/** Why a message must stay queued. An agent who already heard it is named separately from a tool that may have accepted it. */
export function messageRemovalText(message: QueuedMessage): string | undefined {
  if (Object.values(message.recipients ?? {}).some(Boolean)) return "An agent has already received that message. It remains queued for the other agents.";
  if (Object.values(message.deliveries ?? {}).some(receipt => receipt.state !== "waiting")) return "A tool may already have accepted that message. Its delivery record must stay visible.";
  return undefined;
}

export function messageRemovable(message: QueuedMessage): boolean {
  return messageRemovalText(message) === undefined;
}

export function messageDeliveryText(message: QueuedMessage): string {
  const receipts = Object.values(message.deliveries ?? {});
  const heard = Object.values(message.recipients ?? {}).filter(Boolean).length;
  const total = Object.keys(message.recipients ?? {}).length;
  const accepted = receipts.filter(receipt => receipt.state === "accepted").length;
  const uncertain = receipts.some(receipt => receipt.state === "unconfirmed" || receipt.reason === "separate-turn" || receipt.reason === "unknown");
  const sending = receipts.some(receipt => receipt.state === "sending");
  const parts: string[] = [];
  if (heard) parts.push(total > 1 ? `Heard by ${heard} of ${total} agents` : "Heard");
  if (accepted) parts.push(total > 1 ? `Accepted by ${accepted} ${accepted === 1 ? "agent’s tool" : "agents’ tools"}; waiting to be heard` : "Accepted by the tool; waiting to be heard");
  if (uncertain) parts.push("Delivery unconfirmed; will not send again automatically");
  else if (sending) parts.push("Sending; waiting for confirmation");
  if (receipts.some(receipt => receipt.reason === "unsupported")) parts.push("This tool cannot take live guidance; waiting until the turn finishes");
  if (!parts.length) parts.push(message.mode === "queue" ? "Waiting until the turn finishes" : "Waiting to reach the agent");
  else if (total > 1 && total > heard + accepted && !sending && !uncertain) parts.push("Waiting for the other agents");
  return parts.join(" · ");
}
