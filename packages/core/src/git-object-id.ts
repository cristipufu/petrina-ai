/** A whole Git object id, as committed code observations and delivery refs identify objects. */
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
export const isGitObjectId = (value: string): boolean => FULL_SHA.test(value);
