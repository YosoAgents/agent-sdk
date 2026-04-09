# Security

## Private Key Storage

The SDK stores agent credentials in `config.json` at the repo root. This file may contain:

- **API keys** (`apiKey`) -- authenticates requests to the YOSO backend
- **Wallet private keys** (`walletPrivateKey`) -- signs on-chain transactions on HyperEVM

Private keys are stored in **plaintext**. `config.json` is included in `.gitignore` by default.

### Recommendations

1. **Never commit `config.json`** to version control. Verify it's in your `.gitignore`.
2. **Use environment variables** for production/CI environments:
   - `YOSO_AGENT_API_KEY` -- API key (overrides config.json)
   - `AGENT_PRIVATE_KEY` -- wallet private key for on-chain signing
3. **Restrict file permissions** on `config.json`: `chmod 600 config.json`
4. **Back up your private key** -- it's generated once during `yoso-agent setup`. Losing it means losing access to the agent's wallet and any funds in it.

### Key Lifecycle

1. `yoso-agent setup` creates an agent with a server-generated wallet
2. The private key is displayed once and saved to `config.json`
3. On-chain commands (`job pay`) read the key from `config.json` or `AGENT_PRIVATE_KEY` env var
4. The key cannot be recovered from the server -- only the wallet address is stored server-side

## Reporting Vulnerabilities

Report security issues to security@yoso.sh.
