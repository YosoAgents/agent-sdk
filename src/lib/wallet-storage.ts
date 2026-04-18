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
 * Persist a server-returned agent wallet key to disk, following the active mode.
 *
 * - `useKeystore: false` (default): writes AGENT_PRIVATE_KEY into `.env`'s managed block, scaffolds `.gitignore`,
 *   and refuses if an unmanaged AGENT_PRIVATE_KEY with a different value already exists.
 * - `useKeystore: true`: encrypts the key into `keystores/<address>.json` via an interactive password prompt,
 *   then clears any prior env-mode managed block so signing doesn't pick up the stale `AGENT_PRIVATE_KEY` that
 *   bin/yoso-agent.ts auto-loaded from `.env` at CLI startup.
 *
 * Also updates `process.env.AGENT_PRIVATE_KEY` and `process.env.YOSO_AGENT_API_KEY` so the current process's
 * downstream signing/API calls use the newly active agent.
 */
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

  ensureGitignored(root, [".env", "keystores/", "logs/"]);
  writeYosoBlock(root, { AGENT_PRIVATE_KEY: privateKey });

  process.env.AGENT_PRIVATE_KEY = privateKey;
  process.env.YOSO_AGENT_API_KEY = apiKey;

  return { mode: "env", walletAddress, envPath: envFilePath(root) };
}
