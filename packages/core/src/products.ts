import { parseCommand } from "./check-commands.js";
import { isDeliveryMode } from "./delivery-modes.js";
import { involvesProduct, repositoryPublished } from "./repositories.js";
import { normalizeCheckPrerequisites, sameCheckPrerequisites } from "./check-environment.js";
import type { DeepMutable } from "./flow.js";
import type { CheckPrerequisite, DeliveryMode, Id, Product, RepositoryState, Task } from "./model.js";

const ABBREVIATIONS = new Set(["ai", "api", "ui", "ux", "cli", "sdk"]);

/** Used by the add dialog and by the engine when a script omits the name. */
export function suggestProductName(path: string): string {
  const folder = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  return folder.split(/[-_\s]+/).filter(Boolean).map((word) => {
    if (word !== word.toLowerCase()) return word;
    return ABBREVIATIONS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

export const RELEASE_BUMPS = ["patch", "minor", "major"] as const;
export type ReleaseBump = (typeof RELEASE_BUMPS)[number];

export interface ProductSettings {
  name: string;
  delivery: DeliveryMode;
  approveDelivery: boolean;
  shipLowRisk?: boolean | undefined;
  releaseBump?: ReleaseBump | undefined;
}

export type ProductCheckSettingWork = DeepMutable<Pick<RepositoryState, "productId" | "checks">>;

/** Save editable check declarations only; the caller owns persistence and supplies its actual executions. */
export function configureProductChecks(product: DeepMutable<Pick<Product, "id" | "checks" | "checksBy" | "checksFingerprint" | "checksSeen">> | undefined,
  checks: readonly { name: string; command: string }[] | null, executions: Iterable<ProductCheckSettingWork>): void {
  if (!product) throw new Error("This product is no longer in Petrina.");
  const parsed = checks === null ? [] : checks.map((check) => ({
    name: check.name.trim(),
    argv: parseCommand(check.command)
  })).filter((check) => check.name && check.argv.length);
  if (checks !== null && !parsed.length) throw new Error("Give at least one check, as a name and a command.");
  for (const work of executions) {
    if (work.productId === product.id && work.checks) work.checks.current = false;
  }
  if (checks === null) {
    delete product.checks;
    delete product.checksBy;
    delete product.checksFingerprint;
    delete product.checksSeen;
  } else {
    product.checks = parsed;
    product.checksBy = "coordinator";
    delete product.checksFingerprint;
  }
}

export type CheckSetupSettingWork = DeepMutable<Pick<RepositoryState, "productId" | "checkSetupInvalidated" | "checks" | "approvedSha" | "approvedPatch" | "approvedFor" | "pr" | "release" | "landed" | "localUpdate">>;
export interface CheckSetupSettingEffects { id(prefix: Id): Id; now(): number }

/** Save a declaration only; hosts supply their actual bound executions and perform no probes here. */
export function configureProductCheckSetup(product: DeepMutable<Pick<Product, "id" | "checkSetup">> | undefined, requirements: readonly CheckPrerequisite[],
  executions: Iterable<{ taskId: Id; work: CheckSetupSettingWork }>, effects: CheckSetupSettingEffects): boolean {
  const normalized = normalizeCheckPrerequisites(requirements);
  if (!product) throw new Error("This product is no longer in Petrina.");
  if (product.checkSetup && sameCheckPrerequisites(product.checkSetup.requirements, normalized)) return false;
  const revision = effects.id(product.id);
  product.checkSetup = { revision, requirements: normalized.map(requirement => ({ ...requirement, argv: [...requirement.argv] })) };
  for (const { taskId, work } of executions) {
    if (work.productId !== product.id || repositoryPublished(work)) continue;
    work.checkSetupInvalidated = { id: effects.id(taskId), kind: "requirements-changed", at: effects.now(), revision };
    if (work.checks) work.checks.current = false;
    delete work.approvedSha;
    delete work.approvedPatch;
    delete work.approvedFor;
  }
  return true;
}

/** Validate before changing anything, so a rejected save leaves every setting alone. */
export function productName(name: string, products: readonly Product[], except?: Id): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the product a name.");
  if (/[\r\n\u2028\u2029]/.test(name)) throw new Error("Keep the product name on one line.");
  if (trimmed.length > 60) throw new Error("Keep the product name to 60 characters or fewer.");
  const existing = products.find((product) => product.id !== except && product.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) throw new Error(`Another product is already called ${existing.name}.`);
  return trimmed;
}

export function validateProductSettings(settings: ProductSettings, products: readonly Product[], except?: Id): ProductSettings {
  const name = productName(settings.name, products, except);
  if (!isDeliveryMode(settings.delivery) || typeof settings.approveDelivery !== "boolean") throw new Error("Choose what happens when work is ready.");
  if (settings.shipLowRisk !== undefined && typeof settings.shipLowRisk !== "boolean") throw new Error("Choose whether low-risk work ships without asking.");
  if (settings.releaseBump !== undefined && !(RELEASE_BUMPS as readonly string[]).includes(settings.releaseBump)) {
    throw new Error("Choose whether releases bump patch, minor or major.");
  }
  // Left out, optional low-risk and release-bump settings stay as they are.
  return {
    name,
    delivery: settings.delivery,
    approveDelivery: settings.approveDelivery,
    ...(settings.shipLowRisk !== undefined ? { shipLowRisk: settings.shipLowRisk } : {}),
    ...(settings.releaseBump !== undefined ? { releaseBump: settings.releaseBump } : {}),
  };
}

export function applyProductSettings(
  product: DeepMutable<Pick<Product, "id" | "name" | "delivery" | "approveDelivery" | "shipLowRisk" | "releaseBump">>,
  settings: ProductSettings,
  products: readonly Product[],
): void {
  const validated = validateProductSettings(settings, products, product.id);
  product.name = validated.name;
  product.delivery = validated.delivery;
  product.approveDelivery = validated.approveDelivery;
  if (validated.shipLowRisk !== undefined) product.shipLowRisk = validated.shipLowRisk;
  if (validated.releaseBump !== undefined) product.releaseBump = validated.releaseBump;
}

export function productHistory(tasks: readonly Task[], productId: Id): { unfinished: number; finished: number } {
  const own = tasks.filter((task) => involvesProduct(task, productId));
  const finished = own.filter((task) => (task.state === "done" || task.state === "cancelled") && !task.repositories?.some((work) => work.shipping?.step || work.pr?.state === "open" || (work.pr?.state === "closed" && !work.landingAccepted) || (work.localUpdate && !work.localUpdate.pushed))).length;
  return { unfinished: own.length - finished, finished };
}
