import type { Socket } from "socket.io";

import type { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";

export interface RevalidatedTokenContext {
  jti?: string;
  exp?: number;
}

const REVALIDATION_INTERVAL_MS = 30_000;

export const WS_TOKEN_REVALIDATION_CLEANUP_KEY = "_tokenRevalidationCleanup";

/**
 * Long-lived sockets must re-check the access token that authenticated them:
 * revocation (logout, jti blacklist) and expiry are only enforced at
 * handshake time today, so a disconnected/revoked session would otherwise
 * keep receiving realtime data indefinitely. Runs every 30s and disconnects
 * the socket when the token is dead. Fail-open on Redis errors so a transient
 * hiccup does not drop healthy connections.
 */
export function startTokenRevalidation(
  client: Socket,
  payload: RevalidatedTokenContext,
  blacklist: AccessTokenBlacklistService,
): () => void {
  const timer = setInterval(async () => {
    try {
      if (typeof payload.exp === "number" && payload.exp > 0) {
        if (Date.now() / 1000 >= payload.exp) {
          client.disconnect(true);
          return;
        }
      }
      if (payload.jti) {
        const revoked = await blacklist.has(payload.jti);
        if (revoked) {
          client.disconnect(true);
          return;
        }
      }
    } catch {
      // Transient Redis failure: keep the connection.
    }
  }, REVALIDATION_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function attachTokenRevalidation(
  client: Socket,
  payload: RevalidatedTokenContext,
  blacklist: AccessTokenBlacklistService,
) {
  const cleanup = startTokenRevalidation(client, payload, blacklist);
  const existing = (client.data as Record<string, unknown>)[
    WS_TOKEN_REVALIDATION_CLEANUP_KEY
  ];
  if (typeof existing === "function") {
    (existing as () => void)();
  }
  (client.data as Record<string, unknown>)[
    WS_TOKEN_REVALIDATION_CLEANUP_KEY
  ] = cleanup;
}

export function cleanupTokenRevalidation(client: Socket) {
  const cleanup = (client.data as Record<string, unknown>)[
    WS_TOKEN_REVALIDATION_CLEANUP_KEY
  ];
  if (typeof cleanup === "function") {
    (cleanup as () => void)();
  }
  delete (client.data as Record<string, unknown>)[
    WS_TOKEN_REVALIDATION_CLEANUP_KEY
  ];
}
