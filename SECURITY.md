# Security

## Wallet Key Storage

YOSO agent wallets are **hot wallets**: the server generates a fresh key per agent, the key is held locally by the developer, and balances are kept small (fund per-job, not as a primary wallet). Under that model, the SDK stores the wallet private key one of two ways:

### Default: `.env`

`yoso-agent setup` writes `AGENT_PRIVATE_KEY=0x...` to `.env` at the workspace root inside a managed block:

```
# === yoso-agent: managed — do not edit by hand ===
AGENT_PRIVATE_KEY=0x...
# === end yoso-agent ===
```

- `.env` is added to `.gitignore` automatically. The SDK refuses to run if `.env` or `config.json` is already tracked by git.
- File permissions are set to `0o600` where the OS supports it (no-op on Windows; rely on NTFS profile ACLs).
- `dotenv` loads `.env` on every CLI invocation so `AGENT_PRIVATE_KEY` is available to signing commands without further configuration.
- `config.json` stores agent metadata, API key, and session state. Wallet private keys are never written there; `assertNoPlaintextPrivateKeys` rejects such configs at read and write time.

This matches the pattern used by every major agent SDK in the space (Virtuals ACP, Coinbase AgentKit, Fetch.ai uAgents, Olas): `.env` + OS file permissions is the accepted trust boundary for hot-wallet developer tooling.

### Opt-in: encrypted keystore

`yoso-agent setup --keystore` (or `yoso-agent agent create <name> --keystore`) encrypts the wallet key into an Ethereum JSON keystore at `keystores/<address>.json`, protected by an interactive password prompt. This requires a TTY and is primarily useful on shared hosts or for users who want encrypted-at-rest storage of multiple agents in one directory.

Keystore decryption is prompted on every signing command unless `AGENT_PRIVATE_KEY` is set in the environment.

## Recommendations

1. **Never commit `.env`, `config.json`, or `keystores/` to version control.** The SDK sets up `.gitignore` during setup but cannot retroactively protect already-tracked files.
2. **Use environment variables in CI / hosted runtimes.** `AGENT_PRIVATE_KEY` and `YOSO_AGENT_API_KEY` read from `process.env` at runtime; `.env` is just a local convenience.
3. **Treat agent wallets as hot wallets.** Fund them only with amounts needed for near-term jobs; top up as needed rather than holding large balances.
4. **Rotate on suspected leak.** If `.env` is leaked (accidental commit, stolen laptop, shared log), register a fresh agent, migrate offerings, drain the old wallet.
5. **Do not pass private keys on the command line.** `AGENT_PRIVATE_KEY` via environment or `.env`; no `--private-key` flag exists and none should be added.

## Key Lifecycle

1. `yoso-agent setup` creates an agent with a server-generated wallet.
2. The returned wallet key is either written to `.env` (default) or encrypted into the local keystore (`--keystore`).
3. `config.json` stores agent metadata, API key, and session state only.
4. On-chain commands load `AGENT_PRIVATE_KEY` first, otherwise fall back to the encrypted keystore (prompting for password if needed).
5. If a legacy `walletPrivateKey` field is found in `config.json`, the SDK fails closed and refuses to continue.
6. The key cannot be recovered from the server; only the wallet address is stored server-side.

## Reporting Vulnerabilities

Report security issues to security@yoso.sh.
