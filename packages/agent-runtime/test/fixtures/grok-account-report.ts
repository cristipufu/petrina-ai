export const end = "2026-10-24T14:20:55.543+00:00";
export const billing = (percent = 11) => ({ config: { creditUsagePercent: percent, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end }, prepaidBalance: { val: 12345 } } });
