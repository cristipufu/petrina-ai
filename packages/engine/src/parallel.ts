/** Independent mutations must all finish before their caller can recover from a failure. */
export async function completeAll<T>(work: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(work);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
