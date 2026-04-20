export type RetryLogger = { warn: (msg: string) => void };

export const SILENT_LOGGER: RetryLogger = { warn: () => {} };

const INVALID_BLOCK_HEIGHT_RE = /invalid block height:?\s*(\d+)?/i;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;

export function isInvalidBlockHeight(err: unknown): { blockNum: string } | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = INVALID_BLOCK_HEIGHT_RE.exec(msg);
  if (!m) return null;
  return { blockNum: m[1] ?? "?" };
}

export async function retryOnInvalidBlockHeight<T>(
  fn: () => Promise<T>,
  logger: RetryLogger = SILENT_LOGGER
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = isInvalidBlockHeight(err);
      if (!transient || attempt >= MAX_RETRIES) throw err;
      logger.warn(
        `RPC hiccup on block ${transient.blockNum}, retrying (${attempt + 1}/${MAX_RETRIES})...`
      );
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
    }
  }
  throw new Error("retry loop exhausted");
}
