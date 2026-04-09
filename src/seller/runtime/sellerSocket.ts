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

/**
 * Connect to the marketplace socket and start listening for seller events.
 * Returns a cleanup function that disconnects the socket.
 */
export function connectSellerSocket(
  opts: SellerSocketOptions & { insecure?: boolean }
): () => void {
  const { marketplaceUrl: acpUrl, apiKey, callbacks, insecure } = opts;

  if (!insecure && !/^https:\/\//i.test(acpUrl)) {
    throw new Error(
      `Marketplace URL must use HTTPS (got: ${acpUrl}). Pass { insecure: true } to override.`
    );
  }

  const socketUrl = acpUrl.replace(/\/$/, "") + "/ws/agent";
  const socket: Socket = io(socketUrl, {
    auth: { apiKey },
    transports: ["websocket"],
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
  });

  socket.on(SocketEvent.ROOM_JOINED, (_data: unknown, callback?: (ack: boolean) => void) => {
    console.log("[socket] Joined marketplace room");
    if (typeof callback === "function") callback(true);
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

  return disconnect;
}
