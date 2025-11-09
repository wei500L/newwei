import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import type { AxiosError } from "axios";
import { lastValueFrom } from "rxjs";
import { Crawl4aiRequestException } from "./crawl4ai.exception";

export interface Crawl4aiRequest {
  url: string;
  cursor?: string | null;
  concurrency?: number;
  timeRange?: {
    from?: string;
    to?: string;
  };
  keywords?: string[];
  options?: Record<string, unknown>;
}

export interface Crawl4aiArticle {
  url?: string;
  markdown?: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Crawl4aiResponse {
  runId?: string;
  nextCursor?: string;
  warnings?: string[];
  results: Crawl4aiArticle[];
}

@Injectable()
export class Crawl4aiClient {
  constructor(private readonly http: HttpService) {}

  async crawl(request: Crawl4aiRequest): Promise<Crawl4aiResponse> {
    try {
      const response = await lastValueFrom(
        this.http.post<Crawl4aiResponse>("/crawl", request, {
          headers: {
            "content-type": "application/json"
          }
        })
      );
      return {
        results: response.data?.results ?? [],
        nextCursor: response.data?.nextCursor,
        runId: response.data?.runId,
        warnings: response.data?.warnings
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ message?: string }>;
      const status = axiosError.response?.status;
      const message =
        axiosError.response?.data?.message ||
        axiosError.message ||
        "crawl4ai request failed";
      throw new Crawl4aiRequestException(message, status, error);
    }
  }
}
