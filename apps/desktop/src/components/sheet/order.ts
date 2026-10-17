// Lists in the task sheet show what is still open first.



/** Open blockers first, then other open points, then settled ones. */
export function openFirst<T extends { status: string; blocking: boolean }>(items: readonly T[]): T[] {
  const rank = (item: T) => (item.status === "open" ? (item.blocking ? 0 : 1) : item.status === "noted" ? 2 : 3);
  return [...items].sort((a, b) => rank(a) - rank(b));
}
