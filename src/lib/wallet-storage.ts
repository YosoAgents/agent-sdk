import {
  envFilePath,
  hasEnvModeAgent,
  hasConflictingKeyOutsideBlock,
  writeYosoBlock,
  removeYosoBlock,
} from "./env-file.js";
import { ensureGitignored } from "./git-guard.js";
import { saveEncryptedWallet, type EncryptedWalletMetadata } from "./keystore.js";

export type StoredWalletKey =
  | { mode: "keystore"; metadata: EncryptedWalletMetadata }
  | { mode: "env"; walletAddress: string; envPath: string };

export interface StoreAgentKeyParams {
  root: string;
  privateKey: string;
  walletAddress: string;
  apiKey: string;
  useKeystore: boolean;
  /** Emit a user-facing warning when env-mode residue is cleared on keystore write. */
  warn: (msg: string) => void;
}

/**
 * Files and directories both storage modes write that must stay out of git.
 * - `config.json` holds the agent's API key (bearer credential).
 * - `.env` holds AGENT_PRIVATE_KEY (env mode only, but gitignored unconditionally
 *   because the user may also use env mode in the future from the same dir).
 * - `keystores/` holds encrypted wallet blobs (keystore mode).
 * - `logs/` contains seller runtime logs that may echo request payloads.
 */
const SDK_GITIGNORE_ENTRIES = [".env", "config.json", "keystores/", "logs/"];

/**
 * Storage preflight. Runs in both env and keystore modes. MUST be called
 * before any remote agent registration: `ensureGitignored` throws if
 * required entries can't be added because the target files are tracked,
 * and if that throw comes after `createAgentApi`, the user is left with
 * an orphaned server-side agent and no locally saved credentials.
 */
export function preflightStorage(root: string): void {
  ensureGitignored(root, SDK_GITIGNORE_ENTRIES);
}

/** Persist the wallet key (`.env` managed block or encrypted keystore) and update
 *  `process.env.AGENT_PRIVATE_KEY` / `YOSO_AGENT_API_KEY` for the current process.
 *  Caller must run `preflightStorage(root)` before `createAgentApi` to keep
 *  local write failures from orphaning a remote agent. */
export async function storeAgentKey(params: StoreAgentKeyParams): Promise<StoredWalletKey> {
  const { root, privateKey, walletAddress, apiKey, useKeystore, warn } = params;

  if (useKeystore) {
    const metadata = await saveEncryptedWallet(privateKey, walletAddress);
    if (hasEnvModeAgent(root)) {
      removeYosoBlock(root);
      warn(
        "Removed yoso-agent managed block from .env — previous env-mode agent's " +
          "signing key is no longer available in this directory."
      );
    }
    delete process.env.AGENT_PRIVATE_KEY;
    process.env.YOSO_AGENT_API_KEY = apiKey;
    return { mode: "keystore", metadata };
  }

  const conflict = hasConflictingKeyOutsideBlock(root, "AGENT_PRIVATE_KEY", privateKey);
  if (conflict.conflict) {
    throw new Error(
      `Existing AGENT_PRIVATE_KEY in ${envFilePath(root)} outside the yoso-agent managed block ` +
        `has a different value. Remove it manually, then re-run.`
    );
  }

  writeYosoBlock(root, { AGENT_PRIVATE_KEY: privateKey });

  process.env.AGENT_PRIVATE_KEY = privateKey;
  process.env.YOSO_AGENT_API_KEY = apiKey;

  return { mode: "env", walletAddress, envPath: envFilePath(root) };
}
