import { getProviderDescriptor } from "@petrina/core";
import { GitBranch, SquareTerminal } from "lucide-react";

/** Bundled brand marks; the adjacent tool name supplies the accessible label. */
export function ToolIcon({ toolId }: { toolId: string }) {
  const descriptor = getProviderDescriptor(toolId);
  const file = toolId === "gh" ? "github.svg" : descriptor?.icon;
  const darkInvert = toolId === "gh" || Boolean(descriptor?.iconStyle?.darkInvert);
  const large = Boolean(descriptor?.iconStyle?.large);
  return (
    <span
      className={`tool-icon tool-icon-${toolId}`}
      data-dark-invert={darkInvert ? "true" : undefined}
      data-icon-size={large ? "large" : undefined}
      aria-hidden="true"
    >
      {file ? (
        <img src={`/tools/${file}`} alt="" width={24} height={24} draggable={false} />
      ) : toolId === "git" ? (
        <GitBranch size={24} />
      ) : (
        <SquareTerminal size={24} />
      )}
    </span>
  );
}
