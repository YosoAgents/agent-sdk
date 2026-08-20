import client from "./client.js";
import type { JsonObject } from "./types.js";

export interface PriceV2 {
  type: "fixed" | "percentage";
  value: number;
}

export type ExecutionMode = "none" | "confirm" | "autonomous";

export interface JobOfferingData {
  name: string;
  description: string;
  priceV2: PriceV2;
  slaMinutes: number;
  requiredFunds: boolean;
  executionMode?: ExecutionMode;
  requirement: JsonObject;
  deliverable: string;
  resources?: Resource[];
}

export interface Resource {
  name: string;
  description: string;
  url: string;
  params?: JsonObject;
}

export interface AgentData {
  name: string;
  tokenAddress: string;
  resources: Resource[];
  offerings: JobOfferingData[];
}

export interface CreateJobOfferingResponse {
  success: boolean;
  data?: unknown;
}

export interface PaymentUrlResponse {
  url?: string;
  contractAddress?: string;
  chain?: string;
  chainId?: number;
  decimals?: number;
  symbol?: string;
  gasToken?: string;
  rpcUrl?: string;
  explorerUrl?: string;
  agentWallet?: string;
  instructions?: string[];
}

export interface NegotiationPhaseParams {
  accept: boolean;
  content?: string;
}

export interface ExecutionOrderIntent {
  jobId: number;
  clientRequestId?: string;
  order: {
    asset: string;
    side: "buy" | "sell";
    size: string;
    limitPrice: string;
    reduceOnly?: boolean;
    timeInForce?: "Gtc" | "Ioc" | "Alo";
    clientOrderId?: string;
  };
}

type ApiErrorLike = {
  status?: unknown;
  response?: {
    status?: unknown;
  };
};

function apiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as ApiErrorLike;
  if (typeof err.response?.status === "number") return err.response.status;
  return typeof err.status === "number" ? err.status : undefined;
}

interface ExecutionOrderAuthorizationBase {
  status: "blocked" | string;
  executionActionId: string;
  requestHash: string;
}

export type ExecutionOrderAuthorization =
  | (ExecutionOrderAuthorizationBase & {
      authorized: true;
      reason?: string;
    })
  | (ExecutionOrderAuthorizationBase & {
      authorized: false;
      reason: string;
    });

export async function createJobOffering(
  offering: JobOfferingData
): Promise<{ success: boolean; data?: AgentData }> {
  try {
    const { data } = await client.post(`/agents/job-offerings`, {
      data: offering,
    });
    return { success: true, data };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API createJobOffering failed: ${msg}`);
    return { success: false };
  }
}

export async function deleteJobOffering(offeringName: string): Promise<{ success: boolean }> {
  try {
    await client.delete(`/agents/job-offerings/${encodeURIComponent(offeringName)}`);
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API deleteJobOffering failed: ${msg}`);
    return { success: false };
  }
}

export async function updateJobOffering(
  offeringName: string,
  offering: JobOfferingData
): Promise<{ success: boolean; status?: number; error?: string; data?: AgentData }> {
  try {
    const { data } = await client.patch(
      `/agents/job-offerings/${encodeURIComponent(offeringName)}`,
      { data: offering }
    );
    return { success: true, data };
  } catch (error: unknown) {
    const status = apiErrorStatus(error);
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, status, error: msg };
  }
}

export async function getPaymentUrl(): Promise<{
  success: boolean;
  url?: string;
  data?: PaymentUrlResponse;
}> {
  try {
    const { data } = await client.get<{ data: PaymentUrlResponse }>("/agents/topup");
    return { success: true, url: data.data.url, data: data.data };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API getPaymentUrl failed: ${msg}`);
    return { success: false };
  }
}

export async function processNegotiationPhase(
  jobId: number,
  params: NegotiationPhaseParams
): Promise<void> {
  return await client.post(`/agents/providers/jobs/${jobId}/negotiation`, params);
}

export async function authorizeExecutionOrderIntent(intent: ExecutionOrderIntent): Promise<{
  success: boolean;
  data?: ExecutionOrderAuthorization;
  status?: number;
  error?: string;
}> {
  try {
    const { data } = await client.post<{ data: ExecutionOrderAuthorization }>(
      "/agents/execution/orders/authorize",
      intent
    );
    return { success: true, data: data.data };
  } catch (error: unknown) {
    const status = apiErrorStatus(error);
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, status, error: msg };
  }
}

export interface JobDetails {
  id: number;
  phase: number;
  budget: string;
  providerAddress: string;
  clientAddress: string;
  expiry: number | null;
  paymentToken: string | null;
  onChainJobId: string | null;
  escrowTxHash: string | null;
  escrowVerifiedAt: string | null;
  memos?: Array<{
    nextPhase: number;
    status: "pending" | "approved" | "rejected";
    onChainMemoId: string | null;
  }>;
}

export async function getJobDetails(jobId: number): Promise<JobDetails> {
  const { data } = await client.get(`/agents/jobs/${jobId}`);
  return data.data;
}

export async function reportEscrow(
  jobId: number,
  txHash: string,
  onChainJobId: string,
  memoId: string
): Promise<void> {
  await client.post(`/agents/jobs/${jobId}/escrow`, { txHash, onChainJobId, memoId });
}

export interface ActiveJobSummary {
  id: number;
  phase: number;
  clientAddress: string;
  providerAddress: string;
  name: string;
  budget: string;
}

export async function listActiveJobs(pageSize = 100): Promise<ActiveJobSummary[]> {
  const { data } = await client.get<{ data: ActiveJobSummary[] }>(
    `/agents/jobs/active?pageSize=${pageSize}`
  );
  return data.data;
}
