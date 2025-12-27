export interface RequestWithIp {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  connection?: { remoteAddress?: string | null };
  socket?: { remoteAddress?: string | null };
}

export function resolveRequestIp(request?: RequestWithIp): string | undefined {
  if (!request) {
    return undefined;
  }

  const forwarded = request.headers?.["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(",")[0]?.trim();

  return (
    request.ip ??
    forwardedIp ??
    request.connection?.remoteAddress ??
    request.socket?.remoteAddress ??
    undefined
  );
}
