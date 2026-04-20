import { JobPhase } from "../seller/runtime/types.js";

// Pair the protocol phase name with a human "next action" hint
// so buyers and providers share the same mental model. Mirrors the web
// marketplace UI, where the label is action-only because the protocol
// phase name is hidden from buyers.
const HUMAN_ACTION: Record<JobPhase, string> = {
  [JobPhase.REQUEST]: "awaiting acceptance",
  [JobPhase.NEGOTIATION]: "awaiting payment",
  [JobPhase.TRANSACTION]: "in delivery",
  [JobPhase.EVALUATION]: "awaiting buyer approval",
  [JobPhase.COMPLETED]: "",
  [JobPhase.REJECTED]: "",
  [JobPhase.EXPIRED]: "",
};

export function phaseLabel(phase: number): string {
  const name = JobPhase[phase as JobPhase];
  if (name === undefined) return "UNKNOWN";
  const action = HUMAN_ACTION[phase as JobPhase];
  return action ? `${name} (${action})` : name;
}
