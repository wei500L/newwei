import type { Socket } from "socket.io";

/**
 * Whether the deployment trusts the X-Forwarded-For chain. Mirrors the
 * TRUST_PROXY option consumed by main.ts (app.set("trust proxy", ...)): when
 * unset, the header is fully client-controlled and MUST NOT be used for
 * rate-limit/backoff keys (spoofing to bypass limits, or poisoning a victim
 * IP to force backoff).
 */
export function isTrustProxyConfigured(): boolean {
  return Boolean(process.env.TRUST_PROXY?.trim());
}

/**
 * Resolve the real client IP of a socket handshake. X-Forwarded-For is only
 * honored when a trusted proxy chain is configured; otherwise the raw socket
 * address is used.
 */
export function resolveSocketClientIp(
  client: Socket,
  trustProxy: boolean,
): string | undefined {
  let ip: string | undefined;
  if (trustProxy) {
    const forwardedHeader = client.handshake.headers["x-forwarded-for"];
    const forwarded = Array.isArray(forwardedHeader)
      ? forwardedHeader[0]
      : forwardedHeader;
    ip = forwarded?.split(",")[0]?.trim();
  }
  const address =
    typeof client.handshake.address === "string"
      ? client.handshake.address
      : undefined;
  const resolved = ip || address;
  return resolved ? resolved.replace(/^::ffff:/, "") : undefined;
}
