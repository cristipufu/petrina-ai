/** The connection closed before the engine answered; the action may already be saved. */
export class Lost extends Error {}
/** The engine did not answer in time; the action may already be saved. */
export class Late extends Error {}
export const uncertainReply = (failure: unknown): boolean => failure instanceof Lost || failure instanceof Late;
