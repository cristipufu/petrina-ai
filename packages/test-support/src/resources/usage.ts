/** Copy native driver getters into plain, serializable values. Missing readings stay unavailable. */
export function resourceUsageRecord(reading: unknown): { userUs?: number; systemUs?: number; totalUs?: number; maxRssBytes?: number } | undefined {
  if (!reading || typeof reading !== "object") return;
  const source = reading as { cpuTime?: { user?: unknown; system?: unknown; total?: unknown }; maxRSS?: unknown };
  const number = (value: unknown) => typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value)
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const cpu = source.cpuTime;
  const userUs = number(cpu?.user);
  const systemUs = number(cpu?.system);
  const totalUs = number(cpu?.total);
  const maxRssBytes = number(source.maxRSS);
  return userUs !== undefined || systemUs !== undefined || totalUs !== undefined || maxRssBytes !== undefined
    ? {
      ...(userUs !== undefined ? { userUs } : {}),
      ...(systemUs !== undefined ? { systemUs } : {}),
      ...(totalUs !== undefined ? { totalUs } : {}),
      ...(maxRssBytes !== undefined ? { maxRssBytes } : {})
    } : undefined;
}
