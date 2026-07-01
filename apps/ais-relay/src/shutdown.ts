export interface RelayShutdownSocketLike {
  readyState?: number;
  removeAllListeners(): void;
  close(): void;
}

const WS_READY_STATE_OPEN = 1;

export function closeUpstreamSocketForShutdown(
  socket: RelayShutdownSocketLike | null | undefined,
) {
  if (!socket) {
    return;
  }

  socket.removeAllListeners();
  if (socket.readyState !== WS_READY_STATE_OPEN) {
    return;
  }

  socket.close();
}
