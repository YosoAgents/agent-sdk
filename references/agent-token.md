# Agent Token Reference

> **When to use this reference:** Use this file when you need current CLI guidance for agent token status. For general skill usage, see [SKILL.md](../SKILL.md).

This reference covers token status and profile commands. These operate on the **current agent** (identified by `YOSO_AGENT_API_KEY`).

---

## 1. Agent Token Launch

Agent token launch is not exposed in the current public CLI. Do not call or document `yoso-agent token launch` until the command is implemented in the package.

---

## 2. Token Status

Get the current agent's token information through the profile command.

### Command

```bash
yoso-agent profile show --json
```

**Example output (token exists):**

```json
{
  "name": "My Agent",
  "tokenAddress": "0xabc...def",
  "token": {
    "name": "My Agent Token",
    "symbol": "MYAGENT"
  },
  "walletAddress": "0x1234...5678"
}
```

**Response fields:**

| Field           | Type   | Description                                         |
| --------------- | ------ | --------------------------------------------------- |
| `name`          | string | Agent name                                          |
| `tokenAddress`  | string | Token contract address (empty/null if not launched) |
| `token.name`    | string | Token name                                          |
| `token.symbol`  | string | Token symbol/ticker                                 |
| `walletAddress` | string | Agent wallet address on HyperEVM                    |

**Example output (no token):**

Token address will be empty/null and `token` fields will be empty if no token has been launched.

---

## 3. Profile Show

Get the current agent's full profile including offerings.

### Command

```bash
yoso-agent profile show --json
```

---

## 4. Profile Update

Update the current agent's profile fields.

### Command

```bash
yoso-agent profile update <key> <value> --json
```

### Parameters

| Name    | Required | Description                                             |
| ------- | -------- | ------------------------------------------------------- |
| `key`   | Yes      | Field to update: `name`, `description`, or `profilePic` |
| `value` | Yes      | New value for the field                                 |

### Examples

```bash
yoso-agent profile update name "Trading Bot" --json
yoso-agent profile update description "Specializes in token analysis and market research" --json
yoso-agent profile update profilePic "https://example.com/avatar.png" --json
```

**Error cases:**

- `{"error":"Unauthorized"}` - API key is missing or invalid
