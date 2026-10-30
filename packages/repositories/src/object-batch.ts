import { readLooseObjectPacket, run } from "./git.js";
import { completeAll } from "@petrina/core";
import { parseObjectBatch, treeEntries, type GitObject } from "./object-format.js";
export { parseObjectBatch, treeNames, type GitObject } from "./object-format.js";

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** One bounded process for one caller's object packet. No process or reference cache survives this call. */
export async function readObjects(path: string, requests: readonly string[]): Promise<(GitObject | undefined)[]> {
  if (!requests.length) return [];
  if (requests.some(request => !request || request.startsWith("-") || request.includes("\0"))) throw new Error("Not a Git object request");
  const fast = readLooseObjectPacket(path, requests);
  if (fast) return fast;
  // Older supported Git versions have LF batch input and strip a trailing CR. Resolve those paths as argv,
  // then request their immutable ids; ordinary packets still need exactly one process.
  const resolved = await completeAll(requests.map(async request => {
    if (!request.includes("\n") && !request.endsWith("\r")) return request;
    const result = await run(["git", "rev-parse", "--verify", "--quiet", request], path, undefined, { timeoutMs: 30_000 });
    if (result.code === 1 && !result.timedOut && !result.startFailure && !result.stdout && !result.stderr) return undefined;
    if (result.code !== 0 || !oid.test(result.stdout)) throw new Error(`Git could not resolve the saved repository object: ${result.stderr || "no complete answer"}`);
    return result.stdout;
  }));
  const queries = resolved.filter((request): request is string => request !== undefined);
  if (!queries.length) return resolved.map(() => undefined);
  const result = await run(["git", "cat-file", "--batch"], path, queries.join("\n") + "\n", { timeoutMs: 30_000, binaryOutput: true });
  if (result.code !== 0 || result.timedOut || result.startFailure || !result.stdoutBytes) {
    throw new Error(`Git could not read the saved repository objects: ${result.stderr || "no complete answer"}`);
  }
  const objects = parseObjectBatch(result.stdoutBytes, queries);
  let index = 0;
  return resolved.map(request => request === undefined ? undefined : objects[index++]);
}

/** Root files from one caller's versions: one tree packet, then their immutable blob ids. */
export async function plainFilesAt(path: string, refs: readonly string[], name: string): Promise<({ mode: string; text: string } | undefined)[]> {
  if (!name || name.startsWith("-") || name.includes("/") || name.includes("\0")) return refs.map(() => undefined);
  const valid = refs.map((ref, index) => ({ ref, index })).filter(({ ref }) => ref && !ref.startsWith("-") && !ref.includes("\0"));
  const trees = await readObjects(path, valid.map(({ ref }) => `${ref}^{tree}`)), wanted = Buffer.from(name);
  const files = trees.flatMap((tree, index) => {
    if (!tree) return [];
    const entries = treeEntries(tree).filter(entry => entry.name.equals(wanted)), entry = entries[0];
    if (entries.length !== 1 || !entry || (entry.mode & 0o170000) !== 0o100000) return [];
    return [{ index: valid[index]!.index, id: entry.id, mode: entry.mode & 0o100 ? "100755" : "100644" }];
  });
  const blobs = await readObjects(path, files.map(file => file.id));
  const result: ({ mode: string; text: string } | undefined)[] = refs.map(() => undefined);
  files.forEach((file, index) => {
    const blob = blobs[index];
    if (blob?.type === "blob") result[file.index] = { mode: file.mode, text: blob.body.toString("utf8") };
  });
  return result;
}

/** A live commit and a file at the already pinned base, without borrowing any saved freshness flag. */
export async function commitAndFile(path: string, ref: string, base: string, file: string): Promise<{ head: string; tree: string; text?: string }> {
  const [commit, document] = await readObjects(path, [ref, `${base}:${file}`]);
  const tree = commit?.type === "commit" ? /^tree ([a-f0-9]+)\n/.exec(commit.body.toString("utf8"))?.[1] : undefined;
  if (!commit || !tree || !oid.test(tree) || tree.length !== commit.id.length) throw new Error("Git could not read the product's committed version");
  return { head: commit.id, tree, ...(document?.type === "blob" ? { text: document.body.toString("utf8") } : {}) };
}
