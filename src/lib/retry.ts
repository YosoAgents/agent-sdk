export type RetryLogger = { warn: (msg: string) => void };

export const SILENT_LOGGER: RetryLogger = { warn: () => {} };

const INVALID_BLOCK_HEIGHT_RE = /invalid block height:?\s*(\d+)?/i;
const RATE_LIMITED_RE = /rate limited/i;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const RATE_LIMIT_BACKOFF_MS = 1_000;

export function isInvalidBlockHeight(err: unknown): { blockNum: string } | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = INVALID_BLOCK_HEIGHT_RE.exec(msg);
  if (!m) return null;
  return { blockNum: m[1] ?? "?" };
}

function isRateLimited(err: unknown): boolean {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === -32005
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMITED_RE.test(msg);
}

export async function retryOnInvalidBlockHeight<T>(
  fn: () => Promise<T>,
  logger: RetryLogger = SILENT_LOGGER,
  beforeRetry?: (error: unknown) => void | Promise<void>
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const invalidBlockHeight = isInvalidBlockHeight(err);
      const rateLimited = isRateLimited(err);
      if ((!invalidBlockHeight && !rateLimited) || attempt >= MAX_RETRIES) throw err;
      if (invalidBlockHeight) {
        logger.warn(
          `RPC hiccup on block ${invalidBlockHeight.blockNum}, retrying (${attempt + 1}/${MAX_RETRIES})...`
        );
      } else {
        logger.warn(`RPC rate limited, retrying (${attempt + 1}/${MAX_RETRIES})...`);
      }
      await beforeRetry?.(err);
      await new Promise((r) =>
        setTimeout(r, (rateLimited ? RATE_LIMIT_BACKOFF_MS : BASE_BACKOFF_MS) * 2 ** attempt)
      );
    }
  }
  throw new Error("retry loop exhausted");
}
