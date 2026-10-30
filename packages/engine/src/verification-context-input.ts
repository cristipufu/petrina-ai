import { createHash } from "node:crypto";
import { owedAcceptanceTest, type Task } from "@petrina/core";
import type { Section } from "./context-input.js";

export type VerificationVersions = Readonly<Record<string, string | undefined>>;

export interface VerificationContextStorage { saveIndex(dataDir: string, taskId: string, body: string, digest: string): Promise<string> }

/** An index of existing reports, never a replacement for current checks or independent verification. */
export async function verificationContextInput(dataDir: string, task: Pick<Task, "id" | "journey" | "retest" | "repairCheck" | "repair" | "stageIndex" | "plan" | "proofDeliveryGate">, versions: VerificationVersions | (() => Promise<VerificationVersions>) | undefined, storage: VerificationContextStorage): Promise<Section[]> {
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
  const file = await storage.saveIndex(dataDir, task.id, body, digest);
  const firstBuild = records.find((entry) => entry.kind === "implementation");
  const latestTest = records.findLast((entry) => entry.kind === "acceptance");
  const selected = [...new Set([firstBuild, ...records.slice(-3), latestTest].filter((entry) => entry !== undefined))];
  const sections = [{ title: "Earlier implementation and verification evidence", body: `Recorded reports are available at ${JSON.stringify(file)} (reference ${digest}). These are navigation leads, not proof that the current code passes. Builder claims are not independent review votes. Read the relevant report and compare its recorded version before reusing evidence; verify every required acceptance item on the current work. Earlier records without versions or confirmed tool settings remain unknown.\n${selected.map((entry) => `- Node ${entry.node}: ${entry.kind}, profile ${entry.profileId}, ${new Date(entry.at).toISOString()}; ${entry.versions ? `code trees ${JSON.stringify(entry.versions)}` : "code version not recorded"}`).join("\n")}` }];
  const owed = owedAcceptanceTest(task);
  if (owed) {
    // Version observations belong only to this explanation. Ordinary report indexes
    // and empty histories consume none; each actual retest observes its own versions.
    const currentVersions = typeof versions === "function" ? await versions() : versions;
    const previous = latestTest?.versions;
    const known = (value: string | undefined): value is string => !!value && value !== "unavailable";
    const products = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(currentVersions ?? {})])];
    const changed = currentVersions && previous ? products.filter(id => known(previous[id]) && known(currentVersions[id]) && previous[id] !== currentVersions[id]) : undefined;
    const unknown = products.filter(id => !known(previous?.[id]) || !known(currentVersions?.[id]));
    sections.push({ title: "Why acceptance testing runs again", body: `${owed.final ? "This is the final acceptance pass after review: the prior acceptance evidence did not cover the final code or did not pass." : "This run checks the builder's repair of the prior acceptance run, which did not pass; the planned reviews follow."} Prior acceptance report: ${latestTest ? `node ${latestTest.node}` : "not recorded"}. Current code trees: ${currentVersions ? JSON.stringify(currentVersions) : "not recorded"}. ${changed ? `Products with changed trees: ${changed.join(", ") || "none; examine the prior failed or incomplete evidence"}. ${unknown.length ? `Products whose tree comparison is unknown: ${unknown.join(", ")}. Do not infer a change from missing evidence. ` : ""}Compare the prior recorded trees with the current work to inspect the intervening changes.` : "The previous code version was not recorded; do not assume a narrower retest scope."} Use the current product-check evidence provided separately; old passes never automatically satisfy this run.` });
  }
  return sections;
}
