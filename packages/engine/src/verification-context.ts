import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import type { Section } from "./context.js";

/** An index of existing reports, never a replacement for current checks or independent verification. */
export async function verificationContext(dataDir: string, task: Pick<Task, "id" | "journey" | "retest">, currentVersions?: Readonly<Record<string, string | undefined>>): Promise<Section[]> {
  const records = (task.journey ?? []).flatMap((step) => step.endedAt === undefined ? [] : (step.agentResults ?? []).flatMap((result) => {
    const value = result.value as { summary?: unknown; tests?: unknown; changes?: unknown; checks?: unknown } | null;
    if (!value || typeof value.summary !== "string") return [];
    const kind = Array.isArray(value.checks) ? "acceptance" : Array.isArray(value.changes) ? "implementation" : undefined;
    if (!kind) return [];
    const input = step.agentInputs?.findLast((input) => input.roleId === result.roleId && input.profileId === result.profileId && (input.at ?? 0) <= result.at);
    return [{ node: step.id, kind, at: result.at, productId: result.productId, versions: result.versions, roleId: result.roleId, profileId: result.profileId, settings: input?.confirmedSettings, summary: value.summary, tests: value.tests, changes: value.changes, checks: value.checks }];
  }));
  if (!records.length) return [];
  const body = JSON.stringify({ reports: records }, null, 2);
  const digest = createHash("sha256").update(body).digest("hex");
  const folder = join(dataDir, "contexts", task.id, "verification");
  const file = join(folder, `${digest}.json`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (existing !== undefined && existing !== body) throw new Error("The saved verification evidence changed. Try this step again.");
  if (existing === undefined) {
    const temporary = join(folder, `${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  const firstBuild = records.find((entry) => entry.kind === "implementation");
  const latestTest = records.findLast((entry) => entry.kind === "acceptance");
  const selected = [...new Set([firstBuild, ...records.slice(-3), latestTest].filter((entry) => entry !== undefined))];
  const sections = [{ title: "Earlier implementation and verification evidence", body: `Recorded reports are available at ${JSON.stringify(file)} (reference ${digest}). These are navigation leads, not proof that the current code passes. Builder claims are not independent review votes. Read the relevant report and compare its recorded version before reusing evidence; verify every required acceptance item on the current work. Earlier records without versions or confirmed tool settings remain unknown.\n${selected.map((entry) => `- Node ${entry.node}: ${entry.kind}, profile ${entry.profileId}, ${new Date(entry.at).toISOString()}; ${entry.versions ? `code trees ${JSON.stringify(entry.versions)}` : "code version not recorded"}`).join("\n")}` }];
  if (task.retest) {
    const previous = latestTest?.versions;
    const known = (value: string | undefined): value is string => !!value && value !== "unavailable";
    const products = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(currentVersions ?? {})])];
    const changed = currentVersions && previous ? products.filter(id => known(previous[id]) && known(currentVersions[id]) && previous[id] !== currentVersions[id]) : undefined;
    const unknown = products.filter(id => !known(previous?.[id]) || !known(currentVersions?.[id]));
    sections.push({ title: "Why acceptance testing runs again", body: `This is the final acceptance pass after review: the prior acceptance evidence did not cover the final code or did not pass. Prior acceptance report: ${latestTest ? `node ${latestTest.node}` : "not recorded"}. Current code trees: ${currentVersions ? JSON.stringify(currentVersions) : "not recorded"}. ${changed ? `Products with changed trees: ${changed.join(", ") || "none; examine the prior failed or incomplete evidence"}. ${unknown.length ? `Products whose tree comparison is unknown: ${unknown.join(", ")}. Do not infer a change from missing evidence. ` : ""}Compare the prior recorded trees with the current work to inspect the intervening changes.` : "The previous code version was not recorded; do not assume a narrower retest scope."} Use the current product-check evidence provided separately; old passes never automatically satisfy this run.` });
  }
  return sections;
}
