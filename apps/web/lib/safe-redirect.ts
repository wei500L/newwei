export const DEFAULT_POST_LOGIN_REDIRECT = "/dashboard";

/**
 * Resolve a user-supplied post-login `callbackUrl` to a safe, same-origin path.
 *
 * Prevents open-redirect (CWE-601): only relative paths rooted at a single "/"
 * are accepted. Protocol-relative (`//evil.com`), absolute (`https://evil.com`),
 * scheme (`javascript:`), and backslash-normalized (`/\evil.com`) inputs all
 * fall back to {@link DEFAULT_POST_LOGIN_REDIRECT}.
 */
export function resolveSafeRedirect(
  raw: string | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN_REDIRECT,
): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return fallback;
  }
  try {
    // Resolve against a throwaway origin; any input that escapes that origin
    // (e.g. via backslash normalization) is rejected as cross-origin.
    const base = "http://safe.invalid";
    const resolved = new URL(raw, base);
    if (resolved.origin !== base) {
      return fallback;
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
