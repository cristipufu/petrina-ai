import type { DeliveryMode, Id, Product, Task } from "./model.js";

const ABBREVIATIONS = new Set(["ai", "api", "ui", "ux", "cli", "sdk"]);

/** Used by the add dialog and by the engine when a script omits the name. */
export function suggestProductName(path: string): string {
  const folder = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  return folder.split(/[-_\s]+/).filter(Boolean).map((word) => {
    if (word !== word.toLowerCase()) return word;
    return ABBREVIATIONS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

export interface ProductSettings {
  name: string;
  delivery: DeliveryMode;
  approveDelivery: boolean;
  shipLowRisk?: boolean;
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
  if (!["pull-request", "release", "local"].includes(settings.delivery) || typeof settings.approveDelivery !== "boolean") throw new Error("Choose what happens when work is ready.");
  if (settings.shipLowRisk !== undefined && typeof settings.shipLowRisk !== "boolean") throw new Error("Choose whether low-risk work ships without asking.");
  // Left out, the low-risk setting stays as it is.
  return { name, delivery: settings.delivery, approveDelivery: settings.approveDelivery, ...(settings.shipLowRisk !== undefined ? { shipLowRisk: settings.shipLowRisk } : {}) };
}

export function productHistory(tasks: readonly Task[], productId: Id): { unfinished: number; finished: number } {
  const own = tasks.filter((task) => task.productId === productId);
  const finished = own.filter((task) => task.state === "done" || task.state === "cancelled").length;
  return { unfinished: own.length - finished, finished };
}
