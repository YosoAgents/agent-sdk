// Public API surface for programmatic consumers.
// CLI users don't need this — they use `npx yoso-agent`.

// Core types
export type {
  PriceV2,
  JobOfferingData,
  Resource,
  AgentData,
  JobDetails,
  NegotiationPhaseParams,
} from "./lib/api.js";

// Job lifecycle enums & types
export { JobPhase, MemoType, SocketEvent } from "./seller/runtime/types.js";
export type { JobEventData, MemoData } from "./seller/runtime/types.js";

// Offering handler interfaces (for building agents)
export type {
  ExecuteJobResult,
  ValidationResult,
  OfferingHandlers,
  TransferInstruction,
} from "./seller/runtime/offeringTypes.js";

// Contract addresses & config
export { CONTRACTS, HYPEREVM_CHAIN_ID, HYPEREVM_RPC_URL } from "./lib/contracts.js";

// API functions
export { createJobOffering, deleteJobOffering, getJobDetails, reportEscrow } from "./lib/api.js";
