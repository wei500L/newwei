import axios, { AxiosHeaders, type AxiosError, type AxiosRequestConfig } from "axios";

import { emitForbidden, emitUnauthorized } from "./auth-events";
import { env } from "./env";
import { createTraceHeaders } from "./trace";

export interface ApiClientOptions {
  accessToken?: string;
}

export interface ApiAuthSession extends Record<string, unknown> {
  accessToken?: string;
  permissions?: string[];
  user?: {
    permissions?: string[];
  };
}

type RetriableRequestConfig = AxiosRequestConfig & {
  _retry?: boolean;
};

let refreshSessionPromise: Promise<string | null> | null = null;
const SESSION_CACHE_TTL_MS = 5_000;

let cachedSession: ApiAuthSession | null | undefined;
let cachedSessionAt = 0;
let cachedSessionPromise: Promise<ApiAuthSession | null> | null = null;

export const invalidateApiSessionCache = () => {
  cachedSession = undefined;
  cachedSessionAt = 0;
};

async function fetchSession(): Promise<ApiAuthSession | null> {
  if (typeof window === "undefined") {
    return null;
  }

  return import("next-auth/react")
    .then(({ getSession }) => getSession())
    .then((session) => (session as ApiAuthSession | null) ?? null)
    .catch(() => null);
}

export async function getCachedApiSession(): Promise<ApiAuthSession | null> {
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

  cachedSessionPromise = fetchSession()
    .then((session) => {
      cachedSession = session;
      cachedSessionAt = Date.now();
      return session;
    })
    .finally(() => {
      cachedSessionPromise = null;
    });

  return cachedSessionPromise;
}

const refreshAccessToken = async () => {
  if (typeof window === "undefined") {
    return null;
  }

  if (!refreshSessionPromise) {
    refreshSessionPromise = fetchSession()
      .then((session) => {
        cachedSession = session;
        cachedSessionAt = Date.now();
        return session?.accessToken ?? null;
      })
      .catch(() => null)
      .finally(() => {
        refreshSessionPromise = null;
      });
  }

  return refreshSessionPromise;
};

export const createApiClient = (options: ApiClientOptions = {}) => {
  const instance = axios.create({
    baseURL: env.apiBaseUrl,
    withCredentials: true
  });

  if (options.accessToken) {
    instance.defaults.headers.common.Authorization = `Bearer ${options.accessToken}`;
  }

  instance.interceptors.response.use((response) => response, async (error: AxiosError) => {
    const status = error.response?.status;
    const originalRequest = error.config as RetriableRequestConfig | undefined;

    if (status === 401 && typeof window !== "undefined" && originalRequest) {
      invalidateApiSessionCache();
      if (!originalRequest._retry) {
        const refreshedToken = await refreshAccessToken();

        if (refreshedToken) {
          originalRequest._retry = true;
          originalRequest.headers = AxiosHeaders.from({
            ...(originalRequest.headers instanceof AxiosHeaders
              ? originalRequest.headers.toJSON()
              : (originalRequest.headers ?? {})),
            Authorization: `Bearer ${refreshedToken}`
          });
          return instance(originalRequest);
        }
      }

      emitUnauthorized({ status });
    }

    if (status === 403 && typeof window !== "undefined") {
      const payload = error.response?.data as unknown;
      const reason =
        payload && typeof payload === "object" && !Array.isArray(payload) && "message" in payload
          ? (() => {
              const raw = (payload as { message?: unknown }).message;
              const detailRaw = (payload as { detail?: unknown }).detail;
              const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : undefined;
              if (typeof raw === "string") {
                return detail ? `${raw}: ${detail}` : raw;
              }
              if (Array.isArray(raw)) {
                const parts = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
                const message = parts.length > 0 ? parts.join(", ") : undefined;
                return message && detail ? `${message}: ${detail}` : message;
              }
              return detail;
            })()
          : undefined;
      emitForbidden({ status, reason });
    }

    return Promise.reject(error);
  });

  instance.interceptors.request.use(async (config) => {
    const existingHeaders =
      config.headers instanceof AxiosHeaders ? config.headers.toJSON() : (config.headers ?? {});

    const hasAuthorizationHeader = Object.keys(existingHeaders).some(
      (key) => key.toLowerCase() === "authorization",
    );

    const token = hasAuthorizationHeader
      ? null
      : options.accessToken ?? (await getCachedApiSession())?.accessToken ?? null;

    const headersWithAuth = token
      ? {
          ...existingHeaders,
          Authorization: `Bearer ${token}`,
        }
      : existingHeaders;

    const normalizedForTrace = Object.fromEntries(
      Object.entries(headersWithAuth).flatMap(([key, value]) => {
        if (value === undefined || value === null) {
          return [];
        }
        if (Array.isArray(value)) {
          return [[key, value.map(String).join(",")]];
        }
        return [[key, String(value)]];
      })
    );

    config.headers = AxiosHeaders.from({
      ...headersWithAuth,
      ...createTraceHeaders(normalizedForTrace)
    });
    return config;
  });

  return instance;
};
