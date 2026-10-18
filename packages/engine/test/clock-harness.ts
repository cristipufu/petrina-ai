// A fake engine whose wall clock can advance without real waits. Timers still run normally.
// bun clock-harness.ts <petrina folder> <fake dir> <offset file>: the file holds how far ahead the clock is, in milliseconds.
// The offset file is taken off the arguments first: the harness reads a third one as the folder standing in for GitHub.
import { readFileSync } from "node:fs";

const [offsetFile] = process.argv.splice(4, 1);
const realNow = Date.now;
Date.now = () => realNow() + Number(readFileSync(offsetFile!, "utf8"));
await import("./harness.js");
