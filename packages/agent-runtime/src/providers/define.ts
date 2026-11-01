import { PROVIDER_BY_ID, type ProviderId } from "@petrina/core";
import type { ToolAdapter } from "../tool-adapter.js";

export type ProviderRuntimeSpec = Omit<
  ToolAdapter,
  "id" | "name" | "cli" | "models" | "terminalArgs" | "reportsSandbox"
>;

export function defineProviderAdapter<Id extends ProviderId>(id: Id, spec: ProviderRuntimeSpec): ToolAdapter {
  const descriptor = PROVIDER_BY_ID[id];
  return {
    ...spec,
    id: descriptor.id,
    name: descriptor.name,
    cli: descriptor.cli,
    models: descriptor.models,
    ...(descriptor.terminal ? { terminalArgs: descriptor.terminal.formatArgs } : {}),
    ...(descriptor.capabilities.reportsSandbox ? { reportsSandbox: true } : {}),
  };
}
