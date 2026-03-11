"use client";

import { getSession, useSession } from "next-auth/react";
import { useEffect, useRef } from "react";

import {
  invalidateBrowserAuthSessionCache,
  setBrowserAuthSession,
  type BrowserAuthSession,
} from "@/lib/browser-auth-session";

type SessionWithAccessToken = BrowserAuthSession;

const SESSION_REFRESH_LEEWAY_MS = 25_000;

export function ApolloAuthSync() {
  const { data: session, status } = useSession();
  const accessToken = (session as SessionWithAccessToken | null)?.accessToken;
  const accessTokenExpires = (session as SessionWithAccessToken | null)?.accessTokenExpires;
  const refreshTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (status === "authenticated") {
      setBrowserAuthSession((session as SessionWithAccessToken | null) ?? { accessToken });
      return;
    }

    invalidateBrowserAuthSessionCache();
  }, [accessToken, session, status]);

  useEffect(() => {
    if (refreshTimeoutRef.current !== null) {
      window.clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = null;
    }

    if (status !== "authenticated") {
      return;
    }

    if (typeof accessTokenExpires !== "number" || !Number.isFinite(accessTokenExpires) || accessTokenExpires <= 0) {
      return;
    }

    const delayMs = Math.max(0, accessTokenExpires - Date.now() - SESSION_REFRESH_LEEWAY_MS);
    refreshTimeoutRef.current = window.setTimeout(() => {
      void getSession().catch(() => null);
    }, delayMs);

    return () => {
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [accessTokenExpires, status]);

  return null;
}
