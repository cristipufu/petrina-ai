import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease } from "./process-lease.js";

export interface LeasedProgramRecord {
  id: string;
  pid: number;
  kind: string;
  state: "running" | "ended";
  code?: number;
}

/** Private leased scripts with observed start/exit receipts. Receipts alone never confirm native termination. */
export async function createLeasedProgramRecords(folder: string) {
  const lease = await createProcessLease();
  try { mkdirSync(folder, { recursive: true }); }
  catch (error) {
    try { await lease.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Program receipt setup failed and its lease could not close"); }
    throw error;
  }
  return {
    /** The renderer receives the expression for this launch's immutable identity, not a saved PID authority. */
    write(name: string, kind: string, body: (identity: string) => string): string {
      const file = join(folder, name), jsonModule = import.meta.resolve("./fixture-json.ts");
      writeFileSync(file, lease.program(`
const { writeFixtureJson: publishProgramRecord } = await import(${JSON.stringify(jsonModule)});
const fixtureProgramIdentity = { id: crypto.randomUUID(), pid: process.pid, kind: ${JSON.stringify(kind)} };
const fixtureProgramRecord = ${JSON.stringify(folder)} + "/" + fixtureProgramIdentity.id + ".record.json";
process.on("exit", code => publishProgramRecord(fixtureProgramRecord, { ...fixtureProgramIdentity, state: "ended", code }));
publishProgramRecord(fixtureProgramRecord, { ...fixtureProgramIdentity, state: "running" });
${body("fixtureProgramIdentity")}`));
      return file;
    },
    records(): LeasedProgramRecord[] {
      return readdirSync(folder).filter(file => file.endsWith(".record.json")).map(file => JSON.parse(readFileSync(join(folder, file), "utf8")) as LeasedProgramRecord);
    },
    /** Request lease shutdown only. The caller still owns actual command/native exit and output confirmation. */
    close: () => lease.close(),
  };
}
export type LeasedProgramRecords = Awaited<ReturnType<typeof createLeasedProgramRecords>>;
