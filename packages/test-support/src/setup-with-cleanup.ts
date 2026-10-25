/** Transfer ownership only after setup succeeds; failed setup awaits its actual owner's cleanup. */
export async function setupWithCleanup<T>(setup: () => T | Promise<T>, cleanup: () => void | Promise<void>): Promise<T> {
  try { return await setup(); }
  catch (setupError) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([setupError, cleanupError], "Setup failed and its cleanup could not be confirmed"); }
    throw setupError;
  }
}
