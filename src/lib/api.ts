import client from "./client.js";

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
  requirement: Record<string, any>;
  deliverable: string;
  resources?: Resource[];
  subscriptionTiers?: string[];
}

export interface Resource {
  name: string;
  description: string;
  url: string;
  params?: Record<string, any>;
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
  url: string;
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
  } catch (error: any) {
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

export async function upsertResourceApi(
  resource: Resource
): Promise<{ success: boolean; data?: AgentData }> {
  try {
    const { data } = await client.post(`/agents/resources`, {
      data: resource,
    });
    return { success: true, data };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API upsertResource failed: ${msg}`);
    return { success: false };
  }
}

export async function deleteResourceApi(resourceName: string): Promise<{ success: boolean }> {
  try {
    await client.delete(`/agents/resources/${encodeURIComponent(resourceName)}`);
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API deleteResource failed: ${msg}`);
    return { success: false };
  }
}

export async function createSubscription(tier: {
  name: string;
  price: number;
  duration: number;
}): Promise<{
  success: boolean;
  data?: { id: number; name: string; price: number; duration: number };
}> {
  try {
    const { data } = await client.post(`/agents/subscriptions`, tier);
    return { success: true, data: data.data };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API createSubscription failed: ${msg}`);
    return { success: false };
  }
}

export async function updateSubscription(
  name: string,
  updates: { price?: number; duration?: number }
): Promise<{
  success: boolean;
  data?: { id: number; name: string; price: number; duration: number };
}> {
  try {
    const { data } = await client.put(`/agents/subscriptions/${encodeURIComponent(name)}`, updates);
    return { success: true, data: data.data };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API updateSubscription failed: ${msg}`);
    return { success: false };
  }
}

export async function deleteSubscription(name: string): Promise<{ success: boolean }> {
  try {
    await client.delete(`/agents/subscriptions/${encodeURIComponent(name)}`);
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`API deleteSubscription failed: ${msg}`);
    return { success: false };
  }
}

export async function getPaymentUrl(): Promise<{
  success: boolean;
  url?: string;
}> {
  try {
    const { data } = await client.get<{ data: PaymentUrlResponse }>("/agents/topup");
    return { success: true, url: data.data.url };
  } catch (error: any) {
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
