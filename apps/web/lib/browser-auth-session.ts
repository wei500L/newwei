"use client";

const SESSION_CACHE_TTL_MS = 5_000;

export interface BrowserAuthSession {
  accessToken?: string;
  accessTokenExpires?: number;
  error?: string;
  expires?: string;
  orgId?: string;
  permissions?: string[];
  refreshToken?: string;
  user?: {
    email?: string;
    id?: string;
    orgId?: string;
    permissions?: string[];
  };
  organizations?: unknown[];
}

let cachedSession: BrowserAuthSession | null | undefined;
let cachedSessionAt = 0;
let cachedSessionPromise: Promise<BrowserAuthSession | null> | null = null;
let refreshSessionPromise: Promise<BrowserAuthSession | null> | null = null;
let sessionCacheVersion = 0;

async function fetchSession(): Promise<BrowserAuthSession | null> {
  if (typeof window === "undefined") {
    return null;
  }

  return import("next-auth/react")
    .then(({ getSession }) => getSession())
    .then((session) => (session as BrowserAuthSession | null) ?? null)
    .catch(() => null);
}

function clearSessionCacheState() {
  cachedSession = undefined;
  cachedSessionAt = 0;
  cachedSessionPromise = null;
}

function startSessionFetch(markAsRefresh = false): Promise<BrowserAuthSession | null> {
  const requestVersion = sessionCacheVersion;
  const sessionPromise = fetchSession()
    .then((session) => {
      if (requestVersion === sessionCacheVersion) {
        cachedSession = session;
        cachedSessionAt = Date.now();
      }
      return session;
    })
    .finally(() => {
      if (requestVersion === sessionCacheVersion && cachedSessionPromise === sessionPromise) {
        cachedSessionPromise = null;
      }
      if (refreshSessionPromise === sessionPromise) {
        refreshSessionPromise = null;
      }
    });

  cachedSessionPromise = sessionPromise;
  if (markAsRefresh) {
    refreshSessionPromise = sessionPromise;
  }
  return sessionPromise;
}

export function invalidateBrowserAuthSessionCache() {
  sessionCacheVersion += 1;
  clearSessionCacheState();
  refreshSessionPromise = null;
}

export function setBrowserAuthSession(session: BrowserAuthSession | null | undefined) {
  if (typeof window === "undefined") {
    return session ?? null;
  }

  sessionCacheVersion += 1;
  cachedSession = session ?? null;
  cachedSessionAt = Date.now();
  cachedSessionPromise = null;
  refreshSessionPromise = null;
  return cachedSession;
}

export function setBrowserAuthAccessToken(token: string | null | undefined) {
  const normalizedToken = token ?? undefined;
  const nextSession =
    cachedSession && typeof cachedSession === "object"
      ? {
          ...cachedSession,
          accessToken: normalizedToken
        }
      : normalizedToken
        ? { accessToken: normalizedToken }
        : null;

  return setBrowserAuthSession(nextSession);
}

export async function getCachedBrowserAuthSession(): Promise<BrowserAuthSession | null> {
  if (typeof window === "undefined") {
    return null;
  }

  const now = Date.now();
  if (cachedSessionPromise) {
    return cachedSessionPromise;
  }

  if (cachedSession !== undefined && now - cachedSessionAt < SESSION_CACHE_TTL_MS) {
    return cachedSession;
  }

  return startSessionFetch();
}

export async function syncBrowserAuthSession(): Promise<BrowserAuthSession | null> {
  if (typeof window === "undefined") {
    return null;
  }

  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  sessionCacheVersion += 1;
  clearSessionCacheState();
  return startSessionFetch(true);
}

export async function refreshBrowserAccessToken(): Promise<string | null> {
  const session = await syncBrowserAuthSession();
  return session?.accessToken ?? null;
}
