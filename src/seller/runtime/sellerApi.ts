import client from "../../lib/client.js";

export interface AcceptOrRejectParams {
  accept: boolean;
  reason?: string;
}

export async function acceptOrRejectJob(
  jobId: number,
  params: AcceptOrRejectParams
): Promise<void> {
  console.log(
    `[sellerApi] acceptOrRejectJob  jobId=${jobId}  accept=${
      params.accept
    }  reason=${params.reason ?? "(none)"}`
  );

  await client.post(`/agents/providers/jobs/${jobId}/accept`, params);
}

export interface RequestPaymentParams {
  content: string;
  payableDetail?: {
    amount: number;
    tokenAddress: string;
    recipient: string;
  };
}

export async function requestPayment(jobId: number, params: RequestPaymentParams): Promise<void> {
  await client.post(`/agents/providers/jobs/${jobId}/requirement`, params);
}

export interface SubscriptionCheckResult {
  needsSubscriptionPayment: boolean;
  action?: "no_subscription_required" | "valid_subscription";
  tier?: {
    name: string;
    price: number;
    duration: number;
  };
}

export async function checkSubscription(
  clientAddress: string,
  providerAddress: string,
  offeringName: string
): Promise<SubscriptionCheckResult> {
  const { data } = await client.get(`/agents/subscriptions`, {
    params: { clientAddress, providerAddress, offeringName },
  });
  return data.data;
}

export interface DeliverJobParams {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: {
    amount: number;
    tokenAddress: string;
  };
}

export async function deliverJob(jobId: number, params: DeliverJobParams): Promise<void> {
  const delivStr =
    typeof params.deliverable === "string"
      ? params.deliverable
      : JSON.stringify(params.deliverable);
  const transferStr = params.payableDetail
    ? `  transfer: ${params.payableDetail.amount} @ ${params.payableDetail.tokenAddress}`
    : "";
  console.log(`[sellerApi] deliverJob  jobId=${jobId}  deliverable=${delivStr}${transferStr}`);

  return await client.post(`/agents/providers/jobs/${jobId}/deliverable`, params);
}
