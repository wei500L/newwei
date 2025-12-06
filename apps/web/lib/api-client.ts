import axios, { type AxiosError, type AxiosRequestConfig } from "axios";
import { env } from "./env";
import { createTraceHeaders } from "./trace";
import { emitUnauthorized } from "./auth-events";

export interface ApiClientOptions {
  accessToken?: string;
}

type RetriableRequestConfig = AxiosRequestConfig & {
  _retry?: boolean;
};

let refreshSessionPromise: Promise<string | null> | null = null;

const refreshAccessToken = async () => {
  if (typeof window === "undefined") {
    return null;
  }

  if (!refreshSessionPromise) {
    refreshSessionPromise = import("next-auth/react")
      .then(({ getSession }) => getSession())
      .then((session) => session?.accessToken ?? null)
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
      if (!originalRequest._retry) {
        const refreshedToken = await refreshAccessToken();

        if (refreshedToken) {
          originalRequest._retry = true;
          originalRequest.headers = {
            ...originalRequest.headers,
            Authorization: `Bearer ${refreshedToken}`
          };
          return instance(originalRequest);
        }
      }

      emitUnauthorized({ status });
    }

    return Promise.reject(error);
  });

  instance.interceptors.request.use((config) => {
    config.headers = {
      ...config.headers,
      ...createTraceHeaders(config.headers)
    };
    return config;
  });

  return instance;
};
