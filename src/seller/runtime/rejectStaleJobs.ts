import { listActiveJobs } from "../../lib/api.js";
import { acceptOrRejectJob } from "./sellerApi.js";
import { JobPhase } from "./types.js";

const OFFLINE_REJECT_REASON = "Provider was offline when this job was created. Please retry.";

export async function rejectStaleJobs(walletAddress: string): Promise<void> {
  const jobs = await listActiveJobs(100);
  const target = walletAddress.toLowerCase();
  const mine = jobs.filter(
    (j) => j.providerAddress.toLowerCase() === target && j.phase === JobPhase.REQUEST
  );

  if (mine.length === 0) return;

  console.log(`[seller] Rejecting ${mine.length} stale phase-0 job(s) received while offline`);

  for (let i = 0; i < mine.length; i++) {
    const j = mine[i];
    try {
      await acceptOrRejectJob(j.id, { accept: false, reason: OFFLINE_REJECT_REASON });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429/.test(msg) || /rate limit/i.test(msg)) {
        const remaining = mine.length - i;
        console.warn(
          `[seller] Rate limit hit after ${i}/${mine.length} rejections; ${remaining} remain. Reboot in ~60s to finish cleanup.`
        );
        return;
      }
      console.warn(`[seller] Could not reject stale job ${j.id}: ${msg}`);
    }
  }

  if (jobs.length === 100) {
    console.warn(
      "[seller] listActiveJobs hit pageSize=100 cap; some stale jobs may remain unrejected. Reboot to finish."
    );
  }
}
