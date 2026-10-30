export interface GitObject {
  id: string;
  type: "blob" | "tree" | "commit" | "tag";
  body: Buffer;
}

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const unreadable = () => new Error("Git's saved object response could not be read");

/** Byte-counted cat-file output; only an explicit missing record means an absent object. */
export function parseObjectBatch(output: Uint8Array, requests: readonly string[]): (GitObject | undefined)[] {
  const bytes = Buffer.from(output);
  const objects: (GitObject | undefined)[] = [];
  let offset = 0;
  for (const request of requests) {
    // Missing replies echo the exact requested revision, unlike successful object headers.
    const missing = Buffer.from(`${request} missing\n`);
    if (bytes.subarray(offset, offset + missing.length).equals(missing)) {
      objects.push(undefined);
      offset += missing.length;
      continue;
    }
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw unreadable();
    const header = bytes.subarray(offset, end).toString("utf8");
    const match = /^([a-f0-9]+) (blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(header);
    if (!match || !oid.test(match[1]!)) throw unreadable();
    const size = Number(match[3]);
    const start = end + 1;
    const finish = start + size;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(finish) || finish >= bytes.length || bytes[finish] !== 10) throw unreadable();
    objects.push({ id: match[1]!, type: match[2] as GitObject["type"], body: bytes.subarray(start, finish) });
    offset = finish + 1;
  }
  if (offset !== bytes.length) throw unreadable();
  return objects;
}

export interface TreeEntry { mode: number; name: Buffer; id: string }

/** Entries in Git's tree order; names and object ids are bytes, not line-delimited text. */
export function treeEntries(object: GitObject): TreeEntry[] {
  if (object.type !== "tree" || !oid.test(object.id)) throw unreadable();
  const entries: TreeEntry[] = [];
  const bytes = object.body;
  const hashBytes = object.id.length / 2;
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const end = bytes.indexOf(0, space + 1);
    if (space <= offset || end <= space + 1 || !/^[0-7]+$/.test(bytes.subarray(
      offset,
      space
    ).toString("utf8")) || end + 1 + hashBytes > bytes.length) throw unreadable();
    // Git's parsed tree mode is uint16; retain its exact octal folding before canonicalizing a file.
    let mode = 0;
    for (let at = offset; at < space; at++) mode = ((mode << 3) + bytes[at]! - 48) & 0xffff;
    entries.push({ mode, name: bytes.subarray(space + 1, end), id: bytes.subarray(end + 1, end + 1 + hashBytes).toString("hex") });
    offset = end + 1 + hashBytes;
  }
  return entries;
}

export function treeNames(object: GitObject): string[] { return treeEntries(object).map(entry => entry.name.toString("utf8")); }

