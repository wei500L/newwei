import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { lastValueFrom } from "rxjs";

import { EnvService } from "../config/config.service";

export type AkshareGatewayMethod = "GET" | "POST";

@Injectable()
export class AkshareGatewayClient {
  private readonly logger = new Logger(AkshareGatewayClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService
  ) {}

  async request<TResponse = unknown>(input: {
    endpoint: string;
    method?: AkshareGatewayMethod;
    params?: Record<string, string | number>;
    timeoutMs?: number;
  }): Promise<TResponse> {
    const cfg = this.env.akshareConfig;
    const method = input.method ?? "GET";
    const params = input.params ?? {};
    const timeout = input.timeoutMs ?? cfg.timeoutMs;
    const url = this.buildUrl(input.endpoint);

    const execute = async () => {
      const observable = this.http.request<TResponse>({
        method,
        url,
        params: method === "GET" ? params : undefined,
        data: method === "POST" ? params : undefined,
        timeout
      });
      const response = await lastValueFrom(observable);
      return response.data;
    };

    return this.retry(execute, cfg.maxRetries);
  }

  async get<TResponse = unknown>(endpoint: string, params?: Record<string, string | number>) {
    return this.request<TResponse>({ endpoint, method: "GET", params });
  }

  private buildUrl(endpoint: string) {
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      return endpoint;
    }

    const baseUrl = this.env.akshareConfig.baseUrl.replace(/\/$/, "");
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return `${baseUrl}${path}`;
  }

  private async retry<T>(fn: () => Promise<T>, attempts: number) {
    let lastError: unknown;
    const total = Math.max(1, attempts);
    for (let attempt = 1; attempt <= total; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === total) {
          break;
        }
        const delayMs = Math.min(2000 * attempt, 10_000);
        this.logger.warn(`Akshare request failed (attempt ${attempt}/${total}); retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }
}

