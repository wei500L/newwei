import { createLogger } from '@modular/utils';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { EnvService } from '../config/config.service';

interface EnsureCollectionResult {
  name: string;
  vectorSize: number;
}

interface QdrantSearchMatchPayload {
  orgId?: unknown;
  processedItemId?: unknown;
  itemMetaId?: unknown;
  createdAtMs?: unknown;
}

interface QdrantSearchMatch {
  score?: unknown;
  payload?: QdrantSearchMatchPayload;
}

interface QdrantResponse<T> {
  status?: unknown;
  result?: T;
}

const logger = createLogger({ name: 'qdrant' });

const stableUuidFromString = (value: string): string => {
  const hash = createHash('sha256').update(value).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const fetchJson = async <T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: T | null }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = (await response.json().catch(() => null)) as unknown;
    const data = raw && typeof raw === 'object' ? (raw as T) : null;
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
};

@Injectable()
export class QdrantService {
  private readonly collectionCache = new Map<string, EnsureCollectionResult>();

  constructor(private readonly env: EnvService) {}

  async upsertPoints(options: {
    orgId: string;
    embeddingModel: string;
    points: {
      processedItemId: string;
      itemMetaId: string;
      createdAtMs: number;
      vector: number[];
    }[];
  }): Promise<{ upserted: number; collection: string }> {
    if (options.points.length === 0) {
      return { upserted: 0, collection: this.collectionName(options.embeddingModel) };
    }

    const vectorSize = options.points[0]?.vector.length ?? 0;
    const collection = await this.ensureCollection(options.embeddingModel, vectorSize);

    const qdrantPoints = options.points.map((point) => ({
      id: stableUuidFromString(`${options.embeddingModel}:${point.processedItemId}`),
      vector: point.vector,
      payload: {
        orgId: options.orgId,
        embeddingModel: options.embeddingModel,
        processedItemId: point.processedItemId,
        itemMetaId: point.itemMetaId,
        createdAtMs: point.createdAtMs,
      },
    }));

    const url = `${this.env.qdrantUrl}/collections/${collection.name}/points?wait=true`;
    const response = await fetchJson<QdrantResponse<unknown>>(
      url,
      {
        method: 'PUT',
        headers: this.qdrantHeaders(),
        body: JSON.stringify({ points: qdrantPoints }),
      },
      this.env.qdrantTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Qdrant upsert failed with status ${response.status}`);
    }
    if (response.data?.status !== 'ok') {
      throw new Error('Qdrant upsert returned non-ok status');
    }

    return { upserted: options.points.length, collection: collection.name };
  }

  async search(options: {
    orgId: string;
    embeddingModel: string;
    vector: number[];
    limit: number;
    minScore?: number;
    lookbackMs?: number;
  }): Promise<{
    collection: string;
    matches: { processedItemId: string; itemMetaId: string; score: number; createdAtMs: number }[];
  }> {
    const collection = await this.ensureCollection(options.embeddingModel, options.vector.length);

    const must: Record<string, unknown>[] = [
      { key: 'orgId', match: { value: options.orgId } },
    ];
    const lookbackMs = typeof options.lookbackMs === 'number' && Number.isFinite(options.lookbackMs)
      ? Math.max(0, Math.floor(options.lookbackMs))
      : 0;
    if (lookbackMs > 0) {
      const cutoff = Date.now() - lookbackMs;
      must.push({ key: 'createdAtMs', range: { gte: cutoff } });
    }

    const url = `${this.env.qdrantUrl}/collections/${collection.name}/points/search`;
    const response = await fetchJson<QdrantResponse<QdrantSearchMatch[]>>(
      url,
      {
        method: 'POST',
        headers: this.qdrantHeaders(),
        body: JSON.stringify({
          vector: options.vector,
          limit: options.limit,
          with_payload: true,
          score_threshold: options.minScore,
          filter: { must },
        }),
      },
      this.env.qdrantTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Qdrant search failed with status ${response.status}`);
    }

    const result = Array.isArray(response.data?.result) ? response.data.result : [];
    const matches = result
      .map((entry): { processedItemId: string; itemMetaId: string; score: number; createdAtMs: number } | null => {
        const payload = entry.payload ?? {};
        const processedItemId =
          typeof payload.processedItemId === 'string' ? payload.processedItemId : null;
        const itemMetaId = typeof payload.itemMetaId === 'string' ? payload.itemMetaId : null;
        const createdAtMs = typeof payload.createdAtMs === 'number' ? payload.createdAtMs : null;
        const score = typeof entry.score === 'number' ? entry.score : null;
        if (!processedItemId || !itemMetaId || createdAtMs === null || score === null) {
          return null;
        }
        return {
          processedItemId,
          itemMetaId,
          createdAtMs,
          score,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => b.score - a.score);

    return { collection: collection.name, matches };
  }

  private collectionName(embeddingModel: string): string {
    const normalized = embeddingModel.trim().toLowerCase();
    const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    return `${this.env.collectionPrefix}_${hash}`;
  }

  private qdrantHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.env.qdrantApiKey ? { 'api-key': this.env.qdrantApiKey } : {}),
    };
  }

  private async ensureCollection(
    embeddingModel: string,
    vectorSize: number,
  ): Promise<EnsureCollectionResult> {
    const name = this.collectionName(embeddingModel);
    const cached = this.collectionCache.get(name);
    if (cached && cached.vectorSize === vectorSize) {
      return cached;
    }

    const url = `${this.env.qdrantUrl}/collections/${name}`;
    const read = await fetchJson<QdrantResponse<{
      config?: { params?: { vectors?: { size?: unknown } } };
    }>>(
      url,
      { method: 'GET', headers: this.qdrantHeaders() },
      this.env.qdrantTimeoutMs,
    );

    if (read.ok && read.data) {
      const rawSize = read.data.result?.config?.params?.vectors?.size;
      const existingSize = typeof rawSize === 'number' ? rawSize : null;
      if (!existingSize || existingSize !== vectorSize) {
        throw new Error(
          `Qdrant collection size mismatch for ${name}: expected ${vectorSize}, got ${existingSize}`,
        );
      }
      const result: EnsureCollectionResult = { name, vectorSize };
      this.collectionCache.set(name, result);
      return result;
    }

    if (read.status !== 404) {
      throw new Error(`Qdrant collection lookup failed with status ${read.status}`);
    }

    const createUrl = `${this.env.qdrantUrl}/collections/${name}`;
    const created = await fetchJson<QdrantResponse<unknown>>(
      createUrl,
      {
        method: 'PUT',
        headers: this.qdrantHeaders(),
        body: JSON.stringify({
          vectors: { size: vectorSize, distance: 'Cosine' },
          on_disk_payload: true,
        }),
      },
      this.env.qdrantTimeoutMs,
    );
    if (!created.ok) {
      if (created.status === 409) {
        // Concurrent creation (another instance/implementation created the
        // same collection first — TS and Go versions share collection naming
        // and may run in parallel during the Strangler Fig pilot). The
        // collection exists now: re-check its vector size instead of failing.
        const recheck = await fetchJson<QdrantResponse<{
          config?: { params?: { vectors?: { size?: unknown } } };
        }>>(url, { method: 'GET', headers: this.qdrantHeaders() }, this.env.qdrantTimeoutMs);
        const recheckSize = recheck.data?.result?.config?.params?.vectors?.size;
        if (recheck.ok && typeof recheckSize === 'number' && recheckSize === vectorSize) {
          const result: EnsureCollectionResult = { name, vectorSize };
          this.collectionCache.set(name, result);
          return result;
        }
      }
      throw new Error(`Qdrant collection create failed with status ${created.status}`);
    }

    await Promise.all([
      this.ensurePayloadIndex(name, 'orgId', 'keyword'),
      this.ensurePayloadIndex(name, 'createdAtMs', 'integer'),
    ]);

    const result: EnsureCollectionResult = { name, vectorSize };
    this.collectionCache.set(name, result);
    return result;
  }

  private async ensurePayloadIndex(collection: string, fieldName: string, fieldSchema: string) {
    const url = `${this.env.qdrantUrl}/collections/${collection}/index`;
    try {
      const response = await fetchJson<QdrantResponse<unknown>>(
        url,
        {
          method: 'PUT',
          headers: this.qdrantHeaders(),
          body: JSON.stringify({ field_name: fieldName, field_schema: fieldSchema }),
        },
        this.env.qdrantTimeoutMs,
      );
      if (!response.ok) {
        throw new Error(`Qdrant index request failed with status ${response.status}`);
      }
    } catch (error) {
      logger.debug({ error, collection, fieldName }, 'Failed to ensure Qdrant payload index');
    }
  }
}
