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

const SDK_GITIGNORE_ENTRIES = [".env", "config.json", "keystores/", "logs/"];

export function preflightStorage(root: string): void {
  ensureGitignored(root, SDK_GITIGNORE_ENTRIES);
}

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
