import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { tempDir } from "@petrina/test-support/fixtures";

const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();

/** Immutable image seed, private writable capture and destination directories per case. */
export function captureFixture() {
  const root = tempDir("petrina-captures-");
  const captures = join(root, "temporary");
  const storage = join(root, "history");
  const png = Buffer.from(image);
  mkdirSync(captures);
  writeFileSync(join(captures, "chosen.png"), png);
  return { root, captures, storage, png };
}
