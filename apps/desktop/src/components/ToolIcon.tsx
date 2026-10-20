import { GitBranch, SquareTerminal } from "lucide-react";

const ICONS: Record<string, string> = {
  "claude-code": "claude-code.svg",
  codex: "codex.svg",
  grok: "grok.svg",
  antigravity: "antigravity.svg",
  gh: "github.svg",
};

/** Bundled brand marks; the adjacent tool name supplies the accessible label. */
export function ToolIcon({ toolId }: { toolId: string }) {
  const file = ICONS[toolId];
  return (
    <span className={`tool-icon tool-icon-${toolId}`} aria-hidden="true">
      {file ? <img src={`/tools/${file}`} alt="" width={24} height={24} draggable={false} />
        : toolId === "git" ? <GitBranch size={24} /> : <SquareTerminal size={24} />}
    </span>
  );
}
