#!/usr/bin/env npx tsx

import * as fs from "fs";
import * as path from "path";
import { connectSellerSocket } from "./sellerSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJob } from "./sellerApi.js";
import { getJobDetails } from "../../lib/api.js";
import { loadOffering, listOfferings } from "./offerings.js";
import { rejectStaleJobs } from "./rejectStaleJobs.js";
import { JobPhase, type JobEventData, type SignMemoRequestData } from "./types.js";
import type { ExecuteJobResult } from "./offeringTypes.js";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
  sanitizeAgentName,
  requireApiKey,
  ROOT,
} from "../../lib/config.js";
import { ContractClient } from "../../lib/contract-client.js";
import client from "../../lib/client.js";
import type { JsonObject } from "../../lib/types.js";
import { loadSigningWallet } from "../../lib/keystore.js";
import { installTimestampedConsole } from "./timestampedConsole.js";

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

const MARKETPLACE_URL = process.env.YOSO_SOCKET_URL || "https://api.yoso.sh";
let agentDirName: string = "";
let contractClient: ContractClient | null = null;

type NegotiationDetails =
  | { ok: true; offeringName: string; requirements: JsonObject }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNegotiationDetails(data: JobEventData): NegotiationDetails {
  const negotiationMemo = data.memos.find((m) => m.nextPhase === JobPhase.NEGOTIATION);
  if (!negotiationMemo) {
    return { ok: false, reason: "Missing negotiation memo" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(negotiationMemo.content);
  } catch {
    return { ok: false, reason: "Malformed negotiation memo" };
  }

  if (!isRecord(parsed) || typeof parsed.name !== "string" || !parsed.name.trim()) {
    return { ok: false, reason: "Invalid offering name" };
  }

  const requirement = parsed.requirement;
  if (requirement !== undefined && !isRecord(requirement)) {
    return { ok: false, reason: "Invalid service requirements" };
  }

  return {
    ok: true,
    offeringName: parsed.name,
    requirements: requirement ?? {},
  };
}

async function handleNewTask(data: JobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`[seller] New task  jobId=${jobId}  phase=${JobPhase[data.phase] ?? data.phase}`);
  console.log(`         client=${data.clientAddress}  price=${data.price}`);

  if (data.phase === JobPhase.REQUEST) {
    if (!data.memoToSign) {
      return;
    }

    const negotiationMemo = data.memos.find((m) => m.id === Number(data.memoToSign));

    if (negotiationMemo?.nextPhase !== JobPhase.NEGOTIATION) {
      return;
    }

    const details = parseNegotiationDetails(data);
    if (!details.ok) {
      await acceptOrRejectJob(jobId, {
        accept: false,
        reason: details.reason,
      });
      return;
    }
    const { offeringName, requirements } = details;

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
            `[seller] Validation failed for offering "${offeringName}" - rejecting: ${rejectionReason}`
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

      // Re-fetch phase: accept may have advanced the state machine, and
      // requestPayment returns 409 once the REQUEST memo slot is closed.
      let postAcceptPhase: number | null = null;
      try {
        const details = await getJobDetails(jobId);
        postAcceptPhase = details.phase;
      } catch (err) {
        console.log(
          `[seller] Job ${jobId} phase lookup after accept failed (${
            err instanceof Error ? err.message : String(err)
          }); falling through to requestPayment once.`
        );
      }

      if (postAcceptPhase !== null && postAcceptPhase !== JobPhase.REQUEST) {
        console.log(
          `[seller] Job ${jobId} advanced to phase ${JobPhase[postAcceptPhase] ?? postAcceptPhase} during accept; skipping requestPayment.`
        );
        return;
      }

      // Run normal payment flow for all jobs still in REQUEST.
      const funds =
        config.requiredFunds && handlers.requestAdditionalFunds
          ? await handlers.requestAdditionalFunds(requirements)
          : undefined;

      const paymentReason = handlers.requestPayment
        ? await handlers.requestPayment(requirements)
        : (funds?.content ?? "Request accepted");

      try {
        await requestPayment(jobId, {
          content: paymentReason,
          payableDetail: funds
            ? {
                amount: funds.amount,
                tokenAddress: funds.tokenAddress,
                recipient: funds.recipient,
              }
            : undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/409/.test(msg) || /Conflict/i.test(msg)) {
          // 409 = buyer advanced state between phase check and POST;
          // downstream phase still drives delivery, so continue.
          console.warn(
            `[seller] Job ${jobId} requestPayment returned 409 after phase check; job state advanced concurrently — continuing.`
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error(`[seller] Error processing job ${jobId}:`, err);
    }
  }

  // Handle TRANSACTION (deliver)
  if (data.phase === JobPhase.TRANSACTION) {
    const details = parseNegotiationDetails(data);
    if (details.ok) {
      try {
        const { offeringName, requirements } = details;
        const { handlers } = await loadOffering(offeringName, agentDirName);
        console.log(
          `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
        );
        const result: ExecuteJobResult = await handlers.executeJob(requirements);

        await deliverJob(jobId, {
          deliverable: result.deliverable,
          payableDetail: result.payableDetail,
        });
        console.log(`[seller] Job ${jobId} - delivered.`);
      } catch (err) {
        console.error(`[seller] Error delivering job ${jobId}:`, err);
      }
    } else {
      console.log(`[seller] Job ${jobId} in TRANSACTION but ${details.reason} - skipping`);
    }
    return;
  }

  console.log(
    `[seller] Job ${jobId} in phase ${JobPhase[data.phase] ?? data.phase} - no action needed`
  );
}

async function handleSignMemoRequest(data: SignMemoRequestData): Promise<void> {
  const { jobId, memoId } = data;

  if (!contractClient) {
    console.error(
      `[seller] signMemoRequest for job ${jobId} - no on-chain client (missing private key)`
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
  const confirmationLabel =
    data.type === "completion"
      ? data.nextPhase === JobPhase.REJECTED
        ? "Refund"
        : "Claim"
      : "Escrow";
  try {
    await client.post(endpoint, {
      memoId,
      signTxHash: result.data.txHash,
    });
    console.log(`[seller] ${confirmationLabel} confirmed for job ${jobId}`);
  } catch (err) {
    console.error(`[seller] Failed to report ${endpoint} for job ${jobId}:`, err);
  }
}

// Resolve the offerings directory for this agent. Prefers the stable
// wallet-based path; falls back to the legacy `sanitizeAgentName(name)` path
// with a migration warning so existing scaffolds keep working. Name is
// mutable (users can run `profile update name`), wallet is not — so
// renames no longer desync the runtime from its files.
function resolveAgentDir(agentName: string, walletAddress: string): string {
  const offeringsRoot = path.resolve(ROOT, "src", "seller", "offerings");
  const walletDir = walletAddress.toLowerCase();
  const legacyDir = sanitizeAgentName(agentName);

  const walletPath = path.resolve(offeringsRoot, walletDir);
  const legacyPath = path.resolve(offeringsRoot, legacyDir);

  if (fs.existsSync(walletPath)) return walletDir;
  if (legacyDir && fs.existsSync(legacyPath)) {
    console.warn(
      `[seller] Using legacy offerings dir "${legacyDir}". Run \`yoso-agent migrate offerings\` to move them to "${walletDir}".`
    );
    return legacyDir;
  }
  return walletDir;
}

async function main() {
  installTimestampedConsole();

  checkForExistingProcess();

  writePidToConfig(process.pid);

  setupCleanupHandlers();

  let walletAddress: string;
  let backendOfferingCount = 0;
  try {
    const agentData = await getMyAgentInfo();
    walletAddress = agentData.walletAddress;
    agentDirName = resolveAgentDir(agentData.name, walletAddress);
    backendOfferingCount = agentData.jobs?.length ?? 0;
    console.log(`[seller] Agent: ${agentData.name} (dir: ${agentDirName})`);
  } catch (err) {
    console.error("[seller] Failed to resolve agent info:", err);
    process.exit(1);
  }

  const offerings = listOfferings(agentDirName);
  console.log(
    `[seller] Available offerings: ${offerings.length > 0 ? offerings.join(", ") : "(none)"}`
  );

  if (backendOfferingCount > 0 && offerings.length === 0) {
    const walletDir = walletAddress.toLowerCase();
    console.warn(
      `\n[seller] WARNING: Backend has ${backendOfferingCount} offering(s) registered, but none were found locally.\n` +
        `  Expected path: src/seller/offerings/${walletDir}/<offeringName>/\n` +
        `  If you migrated from an older layout, run: yoso-agent migrate offerings\n` +
        `  If this is a fresh workstation, run \`yoso-agent sell create <name>\` to scaffold handlers.\n`
    );
  }

  try {
    const wallet = await loadSigningWallet(walletAddress);
    contractClient = new ContractClient(wallet.privateKey);
    console.log("[seller] On-chain signing enabled");
  } catch (err) {
    console.error(`[seller] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const apiKey = requireApiKey();
  const { ready } = connectSellerSocket({
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
          `[seller] onEvaluate received for job ${data.id} - no action (evaluation handled externally)`
        );
      },
      onSignMemoRequest: (data) => {
        handleSignMemoRequest(data).catch((err) =>
          console.error("[seller] Unhandled error in handleSignMemoRequest:", err)
        );
      },
    },
  });

  try {
    await ready;
    try {
      await rejectStaleJobs(walletAddress);
    } catch (err) {
      console.error("[seller] Stale-job cleanup failed:", err);
    }
  } catch (err) {
    console.error("[seller] Socket never became ready; skipping stale-job cleanup.", err);
  }

  console.log("[seller] Seller runtime is running. Waiting for jobs...\n");
}

main().catch((err) => {
  console.error("[seller] Fatal error:", err);
  process.exit(1);
});
