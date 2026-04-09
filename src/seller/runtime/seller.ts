#!/usr/bin/env npx tsx

import { connectSellerSocket } from "./sellerSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJob, checkSubscription } from "./sellerApi.js";
import { loadOffering, listOfferings } from "./offerings.js";
import { JobPhase, type JobEventData, type SignMemoRequestData } from "./types.js";
import type { ExecuteJobResult } from "./offeringTypes.js";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
  sanitizeAgentName,
  requireApiKey,
  getActiveAgent,
} from "../../lib/config.js";
import { ContractClient } from "../../lib/contract-client.js";
import client from "../../lib/client.js";

function setupCleanupHandlers(): void {
  const cleanup = () => {
    removePidFromConfig();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    console.error("[seller] Uncaught exception:", err);
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[seller] Unhandled rejection at:", promise, "reason:", reason);
    cleanup();
    process.exit(1);
  });
}

const MARKETPLACE_URL = process.env.YOSO_SOCKET_URL || "https://yoso.bet";
let agentDirName: string = "";
let contractClient: ContractClient | null = null;

function resolveOfferingName(data: JobEventData): string | undefined {
  try {
    const negotiationMemo = data.memos.find((m) => m.nextPhase === JobPhase.NEGOTIATION);
    if (negotiationMemo) {
      return JSON.parse(negotiationMemo.content).name;
    }
  } catch {
    return undefined;
  }
}

function resolveServiceRequirements(data: JobEventData): Record<string, any> {
  const negotiationMemo = data.memos.find((m) => m.nextPhase === JobPhase.NEGOTIATION);
  if (negotiationMemo) {
    try {
      return JSON.parse(negotiationMemo.content).requirement;
    } catch {
      return {};
    }
  }
  return {};
}

function isSubscriptionJob(data: JobEventData): boolean {
  const negotiationMemo = data.memos.find((m) => m.nextPhase === JobPhase.NEGOTIATION);
  if (!negotiationMemo) return false;
  try {
    return JSON.parse(negotiationMemo.content).priceType === "subscription";
  } catch {
    return false;
  }
}

async function handleNewTask(data: JobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[seller] New task  jobId=${jobId}  phase=${JobPhase[data.phase] ?? data.phase}`);
  console.log(`         client=${data.clientAddress}  price=${data.price}`);
  console.log(`         context=${JSON.stringify(data.context)}`);
  console.log(`${"=".repeat(60)}`);

  // Step 1: Accept / reject
  if (data.phase === JobPhase.REQUEST) {
    if (!data.memoToSign) {
      return;
    }

    const negotiationMemo = data.memos.find((m) => m.id == Number(data.memoToSign));

    if (negotiationMemo?.nextPhase !== JobPhase.NEGOTIATION) {
      return;
    }

    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (!offeringName) {
      await acceptOrRejectJob(jobId, {
        accept: false,
        reason: "Invalid offering name",
      });
      return;
    }

    try {
      const { config, handlers } = await loadOffering(offeringName, agentDirName);

      if (handlers.validateRequirements) {
        const validationResult = await handlers.validateRequirements(requirements);

        let isValid: boolean;
        let reason: string | undefined;

        if (typeof validationResult === "boolean") {
          isValid = validationResult;
          reason = isValid ? undefined : "Validation failed";
        } else {
          isValid = validationResult.valid;
          reason = validationResult.reason;
        }

        if (!isValid) {
          const rejectionReason = reason || "Validation failed";
          console.log(
            `[seller] Validation failed for offering "${offeringName}" — rejecting: ${rejectionReason}`
          );
          await acceptOrRejectJob(jobId, {
            accept: false,
            reason: rejectionReason,
          });
          return;
        }
      }

      await acceptOrRejectJob(jobId, {
        accept: true,
        reason: "Job accepted",
      });

      // Run normal payment flow for all jobs
      const funds =
        config.requiredFunds && handlers.requestAdditionalFunds
          ? await handlers.requestAdditionalFunds(requirements)
          : undefined;

      const paymentReason = handlers.requestPayment
        ? await handlers.requestPayment(requirements)
        : (funds?.content ?? "Request accepted");

      // For subscription jobs, check status and append to content
      let content = paymentReason;
      if (isSubscriptionJob(data)) {
        const subCheck = await checkSubscription(
          data.clientAddress,
          data.providerAddress,
          offeringName
        );

        if (subCheck.needsSubscriptionPayment && subCheck.tier) {
          console.log(
            `[seller] Job ${jobId} requires subscription payment for tier "${subCheck.tier.name}"`
          );
          content = `${paymentReason}\nSubscription required: ${subCheck.tier.name} (${subCheck.tier.price} USDC for ${subCheck.tier.duration} days)`;
        } else {
          console.log(`[seller] Job ${jobId} — valid subscription, proceeding`);
          content = `${paymentReason}\nSubscription active`;
        }
      }

      await requestPayment(jobId, {
        content,
        payableDetail: funds
          ? {
              amount: funds.amount,
              tokenAddress: funds.tokenAddress,
              recipient: funds.recipient,
            }
          : undefined,
      });
    } catch (err) {
      console.error(`[seller] Error processing job ${jobId}:`, err);
    }
  }

  // Handle TRANSACTION (deliver)
  if (data.phase === JobPhase.TRANSACTION) {
    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (offeringName) {
      try {
        const { handlers } = await loadOffering(offeringName, agentDirName);
        console.log(
          `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
        );
        const result: ExecuteJobResult = await handlers.executeJob(requirements);

        await deliverJob(jobId, {
          deliverable: result.deliverable,
          payableDetail: result.payableDetail,
        });
        console.log(`[seller] Job ${jobId} — delivered.`);
      } catch (err) {
        console.error(`[seller] Error delivering job ${jobId}:`, err);
      }
    } else {
      console.log(`[seller] Job ${jobId} in TRANSACTION but no offering resolved — skipping`);
    }
    return;
  }

  console.log(
    `[seller] Job ${jobId} in phase ${JobPhase[data.phase] ?? data.phase} — no action needed`
  );
}

async function handleSignMemoRequest(data: SignMemoRequestData): Promise<void> {
  const { jobId, memoId } = data;

  if (!contractClient) {
    console.error(
      `[seller] signMemoRequest for job ${jobId} — no on-chain client (missing private key)`
    );
    return;
  }

  console.log(`[seller] Signing memo ${memoId} on-chain for job ${jobId}...`);
  const result = await contractClient.signMemo(memoId, true, "");

  if (!result.success) {
    console.error(`[seller] signMemo failed for memo ${memoId}: ${result.error}`);
    return;
  }

  console.log(`[seller] Memo ${memoId} signed (tx: ${result.data.txHash})`);

  // Report to backend
  const endpoint =
    data.type === "completion"
      ? `/agents/jobs/${jobId}/claim-confirm`
      : `/agents/jobs/${jobId}/escrow-confirm`;
  try {
    await client.post(endpoint, {
      memoId,
      signTxHash: result.data.txHash,
    });
    console.log(
      `[seller] ${data.type === "completion" ? "Claim" : "Escrow"} confirmed for job ${jobId}`
    );
  } catch (err) {
    console.error(`[seller] Failed to report ${endpoint} for job ${jobId}:`, err);
  }
}

async function main() {
  checkForExistingProcess();

  writePidToConfig(process.pid);

  setupCleanupHandlers();

  let walletAddress: string;
  try {
    const agentData = await getMyAgentInfo();
    walletAddress = agentData.walletAddress;
    agentDirName = sanitizeAgentName(agentData.name);
    console.log(`[seller] Agent: ${agentData.name} (dir: ${agentDirName})`);
  } catch (err) {
    console.error("[seller] Failed to resolve agent info:", err);
    process.exit(1);
  }

  const offerings = listOfferings(agentDirName);
  console.log(
    `[seller] Available offerings: ${offerings.length > 0 ? offerings.join(", ") : "(none)"}`
  );

  const activeAgent = getActiveAgent();
  if (activeAgent?.walletPrivateKey) {
    // Verify local key matches the wallet the server knows about
    const { ethers } = await import("ethers");
    const derivedAddress = new ethers.Wallet(activeAgent.walletPrivateKey).address;
    if (derivedAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      console.error(
        `[seller] FATAL: Local private key derives ${derivedAddress}, but server says wallet is ${walletAddress}. Aborting.`
      );
      process.exit(1);
    }
    contractClient = new ContractClient(activeAgent.walletPrivateKey);
    console.log("[seller] On-chain signing enabled");
  } else {
    console.log("[seller] No private key — on-chain signing disabled (paid jobs won't work)");
  }

  const apiKey = requireApiKey();
  connectSellerSocket({
    marketplaceUrl: MARKETPLACE_URL,
    walletAddress,
    apiKey,
    callbacks: {
      onNewTask: (data) => {
        handleNewTask(data).catch((err) =>
          console.error("[seller] Unhandled error in handleNewTask:", err)
        );
      },
      onEvaluate: (data) => {
        console.log(
          `[seller] onEvaluate received for job ${data.id} — no action (evaluation handled externally)`
        );
      },
      onSignMemoRequest: (data) => {
        handleSignMemoRequest(data).catch((err) =>
          console.error("[seller] Unhandled error in handleSignMemoRequest:", err)
        );
      },
    },
  });

  console.log("[seller] Seller runtime is running. Waiting for jobs...\n");
}

main().catch((err) => {
  console.error("[seller] Fatal error:", err);
  process.exit(1);
});
