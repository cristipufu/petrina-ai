import { lstatSync, rmSync } from "node:fs";

/** Remove a settled fixture's private root; only confirmed absence completes disposal. */
export function removeFixtureRoot(root: string): void {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (cause) { throw new Error(`Fixture could not remove ${root}`, { cause }); }
  try { lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return; throw error; }
  throw new Error(`Fixture root remains after removal: ${root}`);
}
