import { z } from 'zod';

import {
  VectorBadResponseError,
  VectorClientError,
  VectorServiceUnavailableError,
  VectorUnauthorizedError,
} from './errors';
import type {
  VectorClientOptions,
  VectorRequestOptions,
  VectorSearchRequest,
  VectorSearchResponse,
  VectorUpsertRequest,
  VectorUpsertResponse,
} from './types';

const VectorUpsertResponseSchema: z.ZodType<VectorUpsertResponse, z.ZodTypeDef, unknown> = z.object({
  upserted: z.number().int().nonnegative(),
  collection: z.string().min(1),
});

const VectorSearchResponseSchema: z.ZodType<VectorSearchResponse, z.ZodTypeDef, unknown> = z.object({
  collection: z.string().min(1),
  matches: z
    .array(
      z.object({
        processedItemId: z.string().min(1),
        itemMetaId: z.string().min(1),
        score: z.number().finite(),
        createdAtMs: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const computeBackoffDelay = (baseDelayMs: number, attempt: number) => {
  const jitter = 0.5 + Math.random();
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(exponential * jitter);
};

const withTimeout = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const abortListener = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeout);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortListener, { once: true });
    }
  }

  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortListener);
    }
  }
};

export class VectorClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: VectorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
  }

  async upsert(request: VectorUpsertRequest, options?: VectorRequestOptions): Promise<VectorUpsertResponse> {
    const url = `${this.baseUrl}/v1/upsert`;
    const body = JSON.stringify(request);

    const response = await this.requestWithRetry(url, body, options);
    const raw = (await response.json().catch(() => null)) as unknown;
    const parsed = VectorUpsertResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VectorBadResponseError('Vector upsert returned invalid payload');
    }
    return parsed.data;
  }

  async search(request: VectorSearchRequest, options?: VectorRequestOptions): Promise<VectorSearchResponse> {
    const url = `${this.baseUrl}/v1/search`;
    const body = JSON.stringify(request);

    const response = await this.requestWithRetry(url, body, options);
    const raw = (await response.json().catch(() => null)) as unknown;
    const parsed = VectorSearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VectorBadResponseError('Vector search returned invalid payload');
    }
    return parsed.data;
  }

  private async requestWithRetry(url: string, body: string, options?: VectorRequestOptions): Promise<Response> {
    let attempt = 0;
    // maxRetries=0 means a single attempt.
    const maxAttempts = this.maxRetries + 1;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await withTimeout(
          async (signal) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-internal-token': this.token,
                ...(options?.traceId ? { 'x-trace-id': options.traceId } : {}),
              },
              body,
              signal,
            });

            if (response.status === 401 || response.status === 403) {
              throw new VectorUnauthorizedError('Vector service authentication failed');
            }
            if (response.status >= 500) {
              throw new VectorServiceUnavailableError(`Vector service returned ${response.status}`);
            }
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              throw new VectorBadResponseError(
                `Vector service returned ${response.status}: ${text.slice(0, 300)}`,
              );
            }
            return response;
          },
          this.timeoutMs,
          options?.signal,
        );
      } catch (error) {
        lastError = error;
        if (error instanceof VectorUnauthorizedError || error instanceof VectorBadResponseError) {
          throw error;
        }

        if (attempt >= maxAttempts) {
          throw error instanceof VectorClientError
            ? error
            : error instanceof Error
              ? error
              : new VectorServiceUnavailableError('Vector request failed', error);
        }

        await sleep(computeBackoffDelay(200, attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new VectorServiceUnavailableError('Vector request failed');
  }
}
