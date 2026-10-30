import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { promptSection } from "../scripted-findings.js";

const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] };
const objectionIds = (text: string) => [...text.matchAll(/^- \[([^\]]+)\]/gm)].map(match => match[1]!);

/** Explicit participant replies; the real design owner builds prompts, settles calls and saves inputs. */
export function designCallAgents(): StartAgentSession {
  const agents = new ScriptedAgents((prompt, signal) => {
    const { text, result } = prompt;
    switch (result) {
      case "plan": {
        const check = { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" };
        const screens = { kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
        return scriptedResult({ rationale: "A small feature: agree on a design, build it, two reviewers.", stages: [
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          ...(text.includes("[screens]") ? [screens, check] : text.includes("[two-checks]") ? [check, screens, check] : [check]),
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
        ] });
      }
      case "brief": {
        if (text.includes("Your result block could not be used")) return scriptedResult({ ...brief,
          answers: objectionIds(text).map(id => ({ id, status: "accepted", byCall: false, answer: "Added it to the brief." })) });
        const call = promptSection(text, "The coordinator's call (final, exact words)");
        const settled = promptSection(text, "Objections answered after the call (answer every one again by id)");
        if (call !== undefined && settled !== undefined) {
          const ids = objectionIds(settled);
          const latest = [...(promptSection(text, "Messages from the coordinator, in order") ?? "").matchAll(/^\d+\. (.+)$/gm)].at(-1)?.[1];
          if (latest === undefined) throw new Error("A revised design call must carry the coordinator's actual instruction");
          return `Revising: ${ids.join(", ")}. Latest note: - ${latest}\n\n${scriptedResult({ ...brief,
            answers: ids.map((id, index) => index === 0
              ? { id, status: "accepted", byCall: false, answer: "Kept it in the brief after your note." }
              : { id, status: "accepted", byCall: true, answer: "Added it to the brief, as the call says." }) })}`;
        }
        if (call !== undefined) {
          const open = objectionIds(promptSection(text, "Objections still open (answer every one by id)") ?? "");
          // Deliberately omit one answer: the real conversation owner must request its correction.
          return `Call: ${call}. Final: ${text.includes("The call is final") ? "yes" : "no"}. Open: ${open.join(", ")}.\n\n${scriptedResult({ ...brief,
            answers: open.slice(0, open.length > 1 ? -1 : undefined).map((id, index) => index === 0
              ? { id, status: "rejected", byCall: true, answer: "Removed it from the brief, as the call says." }
              : { id, status: "accepted", byCall: false, answer: "Added it to the brief." }) })}`;
        }
        if (!text.includes("The coordinator answered")) return scriptedResult({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
        return scriptedResult({ ...brief, answers: [] });
      }
      case "objections":
        if (text.includes("[follow-up]")) return scriptedResult({ objections: [{ text: "Follow-up: name the greeting's colour later.", blocking: false }] });
        if (text.includes("[disagree]")) return scriptedResult({ objections: [
          { text: "The brief does not say who sees the greeting.", blocking: true },
          { text: "Consider a greeting per language.", blocking: false },
        ] });
        throw new Error("The design-call fixture requires its explicit review response");
      case "notes": return scriptedResult({ summary: "Notes from the ux designer.", notes: ["A note from the ux designer"] });
      case "build":
        // These cases inspect the real saved Builder input, then cancel. No Builder result is supplied.
        return new Promise<never>((_resolve, reject) => {
          const stopped = () => reject(new Error("The design-call fixture stopped after saving its Builder input"));
          if (signal.aborted) stopped(); else signal.addEventListener("abort", stopped, { once: true });
        });
      default: throw new Error(`Unexpected participant after the design call: ${result}`);
    }
  });
  // The native recipe has no resume/load capability; returning participants start fresh.
  return (options, role) => options.reopen
    ? Promise.reject(new ReopenFailed("The design-call recipe starts fresh conversations"))
    : agents.start(options, role);
}
