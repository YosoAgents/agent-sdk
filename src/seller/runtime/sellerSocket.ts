import { io, type Socket } from "socket.io-client";
import { SocketEvent, type JobEventData, type SignMemoRequestData } from "./types.js";

export interface SellerSocketCallbacks {
  onNewTask: (data: JobEventData) => void;
  onEvaluate?: (data: JobEventData) => void;
  onSignMemoRequest?: (data: SignMemoRequestData) => void;
}

export interface SellerSocketOptions {
  marketplaceUrl: string;
  walletAddress: string;
  apiKey: string;
  callbacks: SellerSocketCallbacks;
}

export interface SellerSocketHandle {
  disconnect: () => void;
  // Resolves on first `roomJoined` event; rejects after 30s if the socket
  // never reaches a ready state. Startup code should `await` this before
  // running any HTTP cleanup that depends on a subscribed socket.
  ready: Promise<void>;
}

const READY_TIMEOUT_MS = 30_000;

// Connect to the marketplace socket. Returns a handle with `disconnect` and
// a single-fire `ready` promise that resolves on the initial room join.
export function connectSellerSocket(
  opts: SellerSocketOptions & { insecure?: boolean }
): SellerSocketHandle {
  const { marketplaceUrl, apiKey, callbacks, insecure } = opts;

  if (!insecure && !/^https:\/\//i.test(marketplaceUrl)) {
    throw new Error(
      `Marketplace URL must use HTTPS (got: ${marketplaceUrl}). Pass { insecure: true } to override.`
    );
  }

  const socketUrl = marketplaceUrl.replace(/\/$/, "") + "/ws/agent";
  const socket: Socket = io(socketUrl, {
    auth: { apiKey },
    transports: ["websocket"],
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
  });

  let hasJoinedOnce = false;
  let resolveReady: () => void;
  let rejectReady: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimeout = setTimeout(() => {
    if (!hasJoinedOnce) {
      rejectReady(new Error(`socket never joined room within ${READY_TIMEOUT_MS}ms`));
    }
  }, READY_TIMEOUT_MS);
  // Node-specific: don't keep the event loop alive solely for this timer.
  if (typeof readyTimeout.unref === "function") readyTimeout.unref();

  socket.on(SocketEvent.ROOM_JOINED, (_data: unknown, callback?: (ack: boolean) => void) => {
    console.log("[socket] Joined marketplace room");
    if (typeof callback === "function") callback(true);
    if (!hasJoinedOnce) {
      hasJoinedOnce = true;
      clearTimeout(readyTimeout);
      resolveReady();
    }
  });

  socket.on(SocketEvent.ON_NEW_TASK, (data: JobEventData, callback?: (ack: boolean) => void) => {
    if (typeof callback === "function") callback(true);
    console.log(`[socket] onNewTask  jobId=${data.id}  phase=${data.phase}`);
    callbacks.onNewTask(data);
  });

  socket.on(SocketEvent.ON_EVALUATE, (data: JobEventData, callback?: (ack: boolean) => void) => {
    if (typeof callback === "function") callback(true);
    console.log(`[socket] onEvaluate  jobId=${data.id}  phase=${data.phase}`);
    if (callbacks.onEvaluate) {
      callbacks.onEvaluate(data);
    }
  });

  socket.on(
    SocketEvent.SIGN_MEMO_REQUEST,
    (data: SignMemoRequestData, callback?: (ack: boolean) => void) => {
      if (typeof callback === "function") callback(true);
      console.log(`[socket] signMemoRequest  jobId=${data.jobId}  memoId=${data.memoId}`);
      if (callbacks.onSignMemoRequest) {
        callbacks.onSignMemoRequest(data);
      }
    }
  );

  socket.on("connect", () => {
    console.log("[socket] Connected to marketplace");
  });

  socket.on("disconnect", (reason) => {
    console.log(`[socket] Disconnected: ${reason}`);
  });

  socket.on("connect_error", (err) => {
    console.error(`[socket] Connection error: ${err.message}`);
  });

  const disconnect = () => {
    socket.disconnect();
  };

  process.on("SIGINT", () => {
    disconnect();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    disconnect();
    process.exit(0);
  });

  return { disconnect, ready };
}
