import type { JsonObject } from "../../lib/types.js";

export interface TransferInstruction {
  ca: string;
  amount: number;
}

export type Deliverable = string | { type: string; value: unknown };

export interface PayableDetail {
  amount: number;
  tokenAddress: string;
}

export interface ExecuteJobResult {
  deliverable: Deliverable;
  payableDetail?: PayableDetail;
}

export type ValidationResult = boolean | { valid: boolean; reason?: string };

export interface OfferingHandlers {
  executeJob: (request: JsonObject) => Promise<ExecuteJobResult>;
  validateRequirements?: (request: JsonObject) => ValidationResult | Promise<ValidationResult>;
  requestPayment?: (request: JsonObject) => string | Promise<string>;
  requestAdditionalFunds?: (request: JsonObject) =>
    | {
        content?: string;
        amount: number;
        tokenAddress: string;
        recipient: string;
      }
    | Promise<{
        content?: string;
        amount: number;
        tokenAddress: string;
        recipient: string;
      }>;
}
