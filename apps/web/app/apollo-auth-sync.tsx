"use client";

import { getSession, useSession } from "next-auth/react";
import { useEffect, useRef } from "react";

import { setApolloAccessToken } from "@/lib/apollo-client";
import { invalidateApiSessionCache, syncApiSessionCache } from "@/lib/api-client";

type SessionWithAccessToken = { accessToken?: string; accessTokenExpires?: number } & Record<string, unknown>;

const SESSION_REFRESH_LEEWAY_MS = 25_000;

export function ApolloAuthSync() {
  const { data: session, status } = useSession();
  const accessToken = (session as SessionWithAccessToken | null)?.accessToken;
  const accessTokenExpires = (session as SessionWithAccessToken | null)?.accessTokenExpires;
  const refreshTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setApolloAccessToken(status === "authenticated" ? accessToken ?? null : null);

    if (status === "authenticated") {
      void syncApiSessionCache().catch(() => null);
      return;
    }

    invalidateApiSessionCache();
  }, [accessToken, status]);

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
