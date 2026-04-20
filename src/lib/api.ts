import client from "./client.js";
import type { JsonObject } from "./types.js";

export interface PriceV2 {
  type: "fixed" | "percentage";
  value: number;
}

export interface JobOfferingData {
  name: string;
  description: string;
  priceV2: PriceV2;
  slaMinutes: number;
  requiredFunds: boolean;
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
    const status = (error as { response?: { status?: number } })?.response?.status;
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

export interface JobDetails {
  id: number;
  phase: number;
  budget: string;
  providerAddress: string;
  clientAddress: string;
  expiry: number | null;
  paymentToken: string | null;
  onChainJobId: string | null;
  escrowVerifiedAt: string | null;
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
