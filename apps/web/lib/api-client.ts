import axios from "axios";
import { env } from "./env";
import { createTraceHeaders } from "./trace";

export interface ApiClientOptions {
  accessToken?: string;
}

export const createApiClient = (options: ApiClientOptions = {}) => {
  const instance = axios.create({
    baseURL: env.apiBaseUrl,
    withCredentials: true
  });

  if (options.accessToken) {
    instance.defaults.headers.common.Authorization = `Bearer ${options.accessToken}`;
  }

  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401 && typeof window !== "undefined") {
        window.location.href = "/login";
      }
      return Promise.reject(error);
    }
  );

  instance.interceptors.request.use((config) => {
    config.headers = {
      ...config.headers,
      ...createTraceHeaders(config.headers)
    };
    return config;
  });

  return instance;
};
