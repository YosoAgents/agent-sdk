# Agent Wallet Reference

> **When to use this reference:** Use this file when you need detailed information about retrieving the agent's wallet address or balance. For general skill usage, see [SKILL.md](../SKILL.md).

This reference covers agent wallet commands. These operate on the **current agent's wallet** (identified by `YOSO_AGENT_API_KEY`) and retrieve wallet information on the HyperEVM.

---

## 1. Get Wallet Address

Get the wallet address of the current agent.

### Command

```bash
yoso-agent wallet address --json
```

**Example output:**

```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890"
}
```

**Response fields:**

| Field           | Type   | Description                            |
| --------------- | ------ | -------------------------------------- |
| `walletAddress` | string | The agent's wallet address on HyperEVM |

**Error cases:**

- `{"error":"Unauthorized"}` - API key is missing or invalid

---

## 2. Get Wallet Balance

Get all token balances in the current agent's wallet on HyperEVM.

### Command

```bash
yoso-agent wallet balance --json
```

**Example output:**

```json
[
  {
    "network": "hyperevm",
    "tokenAddress": null,
    "tokenBalance": "0x0",
    "tokenMetadata": {
      "symbol": null,
      "decimals": null,
      "name": null,
      "logo": null
    },
    "tokenPrices": [
      {
        "currency": "usd",
        "value": "2097.0244158432",
        "lastUpdatedAt": "2026-02-05T11:04:59Z"
      }
    ]
  },
  {
    "network": "hyperevm",
    "tokenAddress": "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    "tokenBalance": "0x4e20",
    "tokenMetadata": {
      "decimals": 6,
      "logo": null,
      "name": "USD Coin",
      "symbol": "USDC"
    },
    "tokenPrices": [
      {
        "currency": "usd",
        "value": "0.9997921712",
        "lastUpdatedAt": "2026-02-05T11:04:32Z"
      }
    ]
  }
]
```

**Response fields:**

| Field           | Type           | Description                                                                  |
| --------------- | -------------- | ---------------------------------------------------------------------------- |
| `network`       | string         | Blockchain network (e.g., "hyperevm")                                        |
| `tokenAddress`  | string \| null | Contract address of the token (null for native/base token)                   |
| `tokenBalance`  | string         | Balance amount as a hex string                                               |
| `tokenMetadata` | object         | Token metadata object (see below)                                            |
| `tokenPrices`   | array          | Array with price objects containing `currency`, `value`, and `lastUpdatedAt` |

**Token metadata fields:**

| Field      | Type           | Description                                    |
| ---------- | -------------- | ---------------------------------------------- |
| `symbol`   | string \| null | Token symbol/ticker (e.g., "WETH", "USDC")     |
| `decimals` | number \| null | Token decimals for formatting                  |
| `name`     | string \| null | Token name (e.g., "Wrapped Ether", "USD Coin") |
| `logo`     | string \| null | URL to token logo image                        |

**Error cases:**

- `{"error":"Unauthorized"}` - API key is missing or invalid
- `{"error":"Wallet not found"}` - Agent wallet does not exist

---

## 3. Get Topup Instructions

Get funding instructions for the current agent's wallet.

### Command

```bash
yoso-agent wallet topup --json
```

**Example output:**

```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890",
  "contractAddress": "0xb88339cb7199b77e23db6e890353e22632ba630f",
  "chain": "HyperEVM",
  "chainId": 999,
  "symbol": "USDC",
  "gasToken": "HYPE",
  "explorerUrl": "https://hyperevmscan.io/address/0x1234567890123456789012345678901234567890",
  "instructions": [
    "Send USDC to 0x1234567890123456789012345678901234567890 on HyperEVM (chain ID 999)",
    "Send a small amount of HYPE for gas fees"
  ]
}
```

**Response fields:**

| Field             | Type     | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `walletAddress`   | string   | The agent's wallet address on HyperEVM               |
| `url`             | string   | Optional hosted topup URL, when the API provides one |
| `contractAddress` | string   | USDC contract address on HyperEVM                    |
| `chain`           | string   | Chain name                                           |
| `chainId`         | number   | Chain ID                                             |
| `symbol`          | string   | Token symbol to send                                 |
| `gasToken`        | string   | Native gas token                                     |
| `explorerUrl`     | string   | Explorer URL for the agent wallet                    |
| `instructions`    | string[] | Human-readable funding steps returned by the API     |

**Error cases:**

- `{"error":"Unauthorized"}` - API key is missing or invalid
- `{"error":"Failed to get topup instructions"}` - Failed to retrieve funding instructions from API
