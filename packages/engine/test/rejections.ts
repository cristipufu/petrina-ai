import { expect } from "bun:test";

/** Await in JavaScript: Bun's promise matchers synchronously re-enter the I/O dispatcher. */
export function rejectionOf(work: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(work).then(
    () => { throw new Error("Expected the operation to reject, but it completed successfully"); },
    (error) => error,
  );
}

/** Keep the same synchronous throw matcher, after the asynchronous operation has settled. */
export async function expectRejection(work: PromiseLike<unknown>, message?: string | RegExp | Error | (new (...args: any[]) => Error)): Promise<void> {
  const error = await rejectionOf(work);
  const throwing = () => { throw error; };
  if (message === undefined) expect(throwing).toThrow();
  else expect(throwing).toThrow(message);
}
