import {
  BookOpen,
  Compass,
  FlaskConical,
  Hammer,
  Map as MapIcon,
  Palette,
  Scale,
  Search,
  type LucideIcon,
} from "lucide-react";
import { EFFORTS, type AgentProfile, type Effort, type Product, type Role, type RoleIcon, type RunState, type Task } from "@petrina/core";
import { currentPhase, PHASES, phasesInPlan, STATE_LABEL, TOOL_COLORS, type Lookup } from "../lib";

export const ROLE_ICONS: Record<RoleIcon, LucideIcon> = {
  map: MapIcon,
  book: BookOpen,
  compass: Compass,
  scale: Scale,
  palette: Palette,
  hammer: Hammer,
  flask: FlaskConical,
  search: Search,
};

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="petrina-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8f7dff" />
          <stop offset="1" stopColor="#5338e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#petrina-g)" />
      <circle cx="33" cy="26" r="10.5" fill="none" stroke="#fff" strokeWidth="5" />
      <path d="M22.5 26v23" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <circle cx="42.5" cy="45.5" r="3.4" fill="#fff" />
      <circle cx="50" cy="40.5" r="2.7" fill="#fff" fillOpacity=".8" />
      <circle cx="54.2" cy="33" r="2.1" fill="#fff" fillOpacity=".6" />
    </svg>
  );
}

export function RoleAvatar({ role, size = 22 }: { role: Role | undefined; size?: number }) {
  if (!role) return null;
  const Icon = ROLE_ICONS[role.icon];
  return (
    <span className={`avatar tone-${role.tone}`} style={{ width: size, height: size }} title={role.name}>
      <Icon size={Math.round(size * 0.56)} strokeWidth={2.2} />
    </span>
  );
}

export function EffortDots({ effort }: { effort: Effort }) {
  const level = EFFORTS.indexOf(effort);
  return (
    <span className="effort" title={`Effort: ${effort}`}>
      {EFFORTS.map((name, index) => (
        <i key={name} className={index <= level ? "on" : ""} />
      ))}
    </span>
  );
}

export function ProfileChip({ profile, find, showTool = true }: { profile: AgentProfile | undefined; find: Lookup; showTool?: boolean }) {
  if (!profile) return null;
  const tool = find.tool(profile.toolId);
  return (
    <span className="chip profile" title={`${tool?.name ?? profile.toolId} · ${profile.model} · ${profile.effort} effort`}>
      <i className="tool-dot" style={{ background: TOOL_COLORS[profile.toolId] ?? "var(--slate)" }} />
      {showTool ? `${tool?.name ?? profile.toolId} · ` : ""}
      {profile.model}
      <EffortDots effort={profile.effort} />
    </span>
  );
}

export function ProductChip({ product }: { product: Product | undefined }) {
  if (!product) return null;
  return (
    <span className={`product-chip tone-${product.tone}`}>
      <i />
      {product.name}
    </span>
  );
}

export function StatePill({ state }: { state: RunState }) {
  return (
    <span className={`pill ${state}`}>
      {(state === "running" || state === "needs-you") && <span className={`dot ${state}`} />}
      {STATE_LABEL[state]}
    </span>
  );
}

export function Phases({ task }: { task: Task }) {
  const now = currentPhase(task);
  const used = phasesInPlan(task);
  return (
    <div className="phases" aria-label={now >= 0 && now < 5 ? `Phase: ${PHASES[now]}` : undefined}>
      {PHASES.map((name, index) => {
        let cls = "";
        if (!used.has(index)) cls = "skip";
        else if (index < now) cls = "done";
        else if (index === now) cls = `now ${task.state}`;
        return <i key={name} className={cls} title={name} />;
      })}
    </div>
  );
}
