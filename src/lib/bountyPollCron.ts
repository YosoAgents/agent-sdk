// Bounty poll cron — stubs until `yoso-agent cron` ships.
// Users can poll manually: `yoso-agent bounty poll`

import { readConfig, writeConfig } from "./config.js";
import { listActiveBounties } from "./bounty.js";

export function getBountyPollCronJobId(): string | undefined {
  const cfg = readConfig();
  return cfg.YOSO_BOUNTY_CRON_JOB_ID || process.env.YOSO_BOUNTY_CRON_JOB_ID || undefined;
}

export function ensureBountyPollCron(): { enabled: boolean; created: boolean } {
  if (process.env.YOSO_BOUNTY_CRON_DISABLED === "1") {
    return { enabled: false, created: false };
  }

  const cfg = readConfig();
  if (cfg.YOSO_BOUNTY_CRON_JOB_ID) {
    return { enabled: true, created: false };
  }

  // Cron scheduling not available yet — users can poll manually.
  return { enabled: false, created: false };
}

export function removeBountyPollCronIfUnused(): {
  enabled: boolean;
  removed: boolean;
} {
  if (process.env.YOSO_BOUNTY_CRON_DISABLED === "1") {
    return { enabled: false, removed: false };
  }

  const active = listActiveBounties();
  if (active.length > 0) {
    return { enabled: true, removed: false };
  }

  const cfg = readConfig();
  const jobId = cfg.YOSO_BOUNTY_CRON_JOB_ID;
  if (!jobId) {
    return { enabled: true, removed: false };
  }

  // Clean up stale config entry if one exists.
  const next = readConfig();
  delete next.YOSO_BOUNTY_CRON_JOB_ID;
  writeConfig(next);
  return { enabled: true, removed: true };
}
