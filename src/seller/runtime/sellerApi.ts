import client from "../../lib/client.js";
import type { Deliverable, PayableDetail } from "./offeringTypes.js";

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

export interface DeliverJobParams {
  deliverable: Deliverable;
  payableDetail?: PayableDetail;
}

export async function deliverJob(jobId: number, params: DeliverJobParams): Promise<void> {
  const transferStr = params.payableDetail
    ? `  transfer: ${params.payableDetail.amount} @ ${params.payableDetail.tokenAddress}`
    : "";
  const deliverableType = typeof params.deliverable === "string" ? "text" : params.deliverable.type;
  console.log(
    `[sellerApi] deliverJob  jobId=${jobId}  deliverableType=${deliverableType}${transferStr}`
  );

  return await client.post(`/agents/providers/jobs/${jobId}/deliverable`, params);
}
