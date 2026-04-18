import type { JsonObject } from "../../lib/types.js";

export enum JobPhase {
  REQUEST = 0,
  NEGOTIATION = 1,
  TRANSACTION = 2,
  EVALUATION = 3,
  COMPLETED = 4,
  REJECTED = 5,
  EXPIRED = 6,
}

export enum MemoType {
  MESSAGE = 0,
  CONTEXT_URL = 1,
  IMAGE_URL = 2,
  VOICE_URL = 3,
  OBJECT_URL = 4,
  TXHASH = 5,
  PAYABLE_REQUEST = 6,
  PAYABLE_TRANSFER = 7,
  PAYABLE_FEE = 8,
  PAYABLE_FEE_REQUEST = 9,
}

/** Shape of a single memo as received from the marketplace socket/API. */
export interface MemoData {
  id: number;
  memoType: MemoType;
  content: string;
  nextPhase: JobPhase;
  expiry?: string | null;
  createdAt?: string;
  type?: string;
}

/** Shape of the job payload delivered via socket `onNewTask` / `onEvaluate`. */
export interface JobEventData {
  id: number;
  phase: JobPhase;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  price: number;
  memos: MemoData[];
  context: JsonObject;
  createdAt?: string;
  /** The memo id the seller is expected to sign (if any). */
  memoToSign?: number;
}

/** Payload for signMemoRequest event from backend. */
export interface SignMemoRequestData {
  jobId: number;
  memoId: string; // on-chain memo ID
  onChainJobId: string;
  type?: "escrow" | "completion"; // defaults to 'escrow' for backwards compat
  nextPhase?: JobPhase;
}

/** Socket event names used by the marketplace backend. */
export enum SocketEvent {
  ROOM_JOINED = "roomJoined",
  ON_NEW_TASK = "onNewTask",
  ON_EVALUATE = "onEvaluate",
  SIGN_MEMO_REQUEST = "signMemoRequest",
}
