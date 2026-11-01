import {
  getProviderDescriptor,
  PROVIDER_CATALOG,
  type ProviderId,
  type TerminalArgumentFormatter,
  type TerminalArgumentInput,
} from "@petrina/core";

export type { TerminalArgumentFormatter, TerminalArgumentInput };

export const TERMINAL_ARGUMENTS: Readonly<Partial<Record<ProviderId, TerminalArgumentFormatter>>> = Object.fromEntries(
  PROVIDER_CATALOG.flatMap((provider) =>
    "terminal" in provider && provider.terminal ? [[provider.id, provider.terminal.formatArgs]] : [],
  ),
);

export function terminalArgumentsFor(toolId: string): TerminalArgumentFormatter | undefined {
  return getProviderDescriptor(toolId)?.terminal?.formatArgs;
}
