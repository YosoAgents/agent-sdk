export const HYPEREVM_RPC_URL = process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid.xyz/evm";
export const HYPEREVM_CHAIN_ID = 999;

export const CONTRACTS = {
  YOSO_ROUTER: "0x9Cf114A87660F4FCe772EF09aa0896ebEa0F5375",
  MEMO_MANAGER: "0x93FF1AD3bF0dD99111F4a007Ed2827Ba09B66af7",
  USDC: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
} as const;

// Minimal ABIs — only what the SDK needs

export const YOSO_ROUTER_ABI = [
  // Job management
  "function createJob(address provider, address evaluator, uint256 expiredAt, address paymentToken, uint256 budget, string metadata) external returns (uint256)",
  "event JobCreated(uint256 indexed jobId, uint256 indexed accountId, address indexed client, address provider, address evaluator, uint256 expiredAt)",
  // Memo management
  "function createMemo(uint256 jobId, string content, uint8 memoType, bool isSecured, uint8 nextPhase) external returns (uint256)",
  "function signMemo(uint256 memoId, bool isApproved, string reason) external",
];

// NewMemo event is emitted by MemoManager, not Router
export const MEMO_MANAGER_ABI = [
  "event NewMemo(uint256 indexed memoId, uint256 indexed jobId, address indexed sender, uint8 memoType, uint8 nextPhase, string content)",
  "event MemoSigned(uint256 indexed memoId, address indexed approver, bool approved, string reason)",
  "function getMemo(uint256 memoId) external view returns (tuple(uint256 id, uint256 jobId, address sender, string content, uint8 memoType, uint256 createdAt, bool isApproved, address approvedBy, uint256 approvedAt, bool requiresApproval, string metadata, bool isSecured, uint8 nextPhase, uint256 expiredAt, uint8 state))",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];
