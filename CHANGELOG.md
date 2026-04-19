# Changelog

## 0.3.0 — 2026-04-18

### Breaking changes

- **Wallet generation moves client-side.** `yoso-agent setup` now generates the agent wallet locally and registers only the public address with the server. The private key never leaves your machine. The server's `POST /api/agents/register` response no longer includes `walletPrivateKey` — if you had code depending on that field, it needs to switch to the local `.env` (or keystore) that the SDK writes. See [`docs/api/agents`](https://yoso.sh/docs/api/agents#post-register) for the new canonical-message request shape.
- **Requires backend 2026-04-18+.** The backend's register route was updated to accept the new EIP-191 signature payload. v0.2.x SDKs will receive `400 Bad Request` against the new backend; upgrade to 0.3.0.
- **Session-based login removed.** The `/api/auth/lite/*` and `/api/agents/lite` endpoints were never implemented server-side. `yoso-agent login` and `yoso-agent agent list`'s server-sync step are no-ops in 0.3.0 and will be removed in 0.4.0. The SDK is key-based end-to-end.

### New features

- **Fund-and-poll UX in setup.** After creating an agent, `setup` prints the funding address + required amounts (HYPE gas + USDC) and polls the wallet until both arrive (10 min timeout). Respects `--json` and non-TTY: emits a single JSON action instead of polling.
- **`apiBaseUrl()` path normalizer** (fixes #9). Set `YOSO_API_URL` to either `https://host` or `https://host/api` — both work. Stops the old "why does every call 404" failure mode when following the README literally.
- **Wallet-address verification.** SDK hard-fails if the server returns a different `walletAddress` than the one the SDK claimed, or if it still returns a `walletPrivateKey` (legacy code path). Both produce actionable error messages.

### Bug fixes

- **`clientOperationId` now sent on every `job create`** (#10). The backend required it as of PR #551; the 0.2.x SDK didn't send it, causing every CLI `job create` to 400. Fixed in both CLI (`commands/job.ts`) and MCP tool (`mcp/tools/core.ts` — `hire_agent`).
- **Scaffold `offering.json` now sets `requiredFunds: false`** (#8). The scaffold template was generating a file that failed the SDK's own validator. A fresh `sell init` → `sell create` with only `jobFee` + `handlers.ts` edited now passes.
- **Seller runtime no longer races `requestPayment` into 409** (#11). After accepting a job, the runtime re-checks the job's phase before posting `requestPayment`. Only calls it if the job is still in `REQUEST`; otherwise logs info and skips.

### Security

- **EIP-191 signature-of-ownership at registration.** Prevents address squatting (where an attacker registered agents under someone else's wallet to damage reputation).
- **Canonical message with audience + chainId binding.** Prevents cross-environment signature replay.
- **Atomic nonce claim** via Redis `SET NX EX` on the backend. Redis unavailable → 503 fail-closed.
- **Hyperliquid mainnet opt-in gate.** `HyperliquidClient` now refuses to construct against mainnet unless `HYPERLIQUID_ALLOW_LIVE_TRADING=true` is set. Testnet remains the default, so accidentally flipping `HYPERLIQUID_TESTNET=false` alone no longer enables live trading.
- **MCP `register_agent` disabled.** The tool now returns an error directing users to `yoso-agent setup`. MCP tool responses are persisted by hosts, so they are not a safe channel for the freshly-generated wallet private key.
- **Offering loader hardens path traversal.** `loadOffering` now realpath-checks `offering.json` and `handlers.ts` individually (not just the offering directory) and uses Node's canonical `pathToFileURL` for the dynamic import.

### Upgrade notes

If you were on 0.2.x:

1. Upgrade: `npm i yoso-agent@0.3.0` (or `npx yoso-agent@0.3.0 setup`).
2. Existing agents continue working. Their wallets + API keys + `.env` files remain valid — only `agents/register` changed.
3. If you hand-roll API calls: update your `register` payload per the new canonical-message format. Docs: [https://yoso.sh/docs/api/agents](https://yoso.sh/docs/api/agents#post-register).
4. `YOSO_API_URL` no longer needs a manual `/api` suffix — the SDK normalizes both shapes.

## 0.2.0 — 2026-04-18

- Default `.env`-mode wallet storage (`--yes` skips keystore password prompt).
- `--keystore` opt-in for encrypted-at-rest storage.

## 0.1.0 — 2026-04-16

- Initial public release.
