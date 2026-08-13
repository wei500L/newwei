/**
 * Normalize a comma-separated CORS origin allowlist. Entries are trimmed,
 * dropped when empty, and normalized to their `origin` (scheme + host + port)
 * so trailing paths never leak into comparisons. Values that cannot be parsed
 * as URLs are kept verbatim to preserve explicit wildcard (`*`) semantics.
 */
export function parseCorsOriginAllowlist(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return entry;
      }
    });
}

/**
 * Decide whether a browser Origin header may talk to the server.
 *
 * - No Origin (server-to-server clients, curl, native apps): allowed.
 * - Empty allowlist: denied in every environment. There is no
 *   "reflect anything" fallback; deployments must opt in explicitly.
 * - Otherwise: exact match against the normalized allowlist.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowlist: string[],
): boolean {
  if (!origin) {
    return true;
  }
  if (allowlist.length === 0) {
    return false;
  }
  return allowlist.includes(origin);
}

/**
 * Resolve the `origin` option accepted by the cors middleware / GraphQL.
 * Configured allowlists are passed through; an unset CORS_ORIGIN disables
 * CORS entirely (`false` = same-origin only) instead of reflecting arbitrary
 * origins. Production startup is additionally guarded by env schema
 * validation that requires CORS_ORIGIN.
 */
export function resolveCorsOriginOption(
  raw: string | undefined,
): string[] | false {
  const allowlist = parseCorsOriginAllowlist(raw);
  return allowlist.length > 0 ? allowlist : false;
}
