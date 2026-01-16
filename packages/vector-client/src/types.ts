export interface VectorClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface VectorRequestOptions {
  traceId?: string;
  signal?: AbortSignal;
}

export interface VectorPointUpsert {
  processedItemId: string;
  itemMetaId: string;
  createdAtMs: number;
  vector: number[];
}

export interface VectorUpsertRequest {
  orgId: string;
  embeddingModel: string;
  points: VectorPointUpsert[];
}

export interface VectorUpsertResponse {
  upserted: number;
  collection: string;
}

export interface VectorSearchRequest {
  orgId: string;
  embeddingModel: string;
  vector: number[];
  limit?: number;
  minScore?: number;
  lookbackMs?: number;
}

export interface VectorSearchMatch {
  processedItemId: string;
  itemMetaId: string;
  score: number;
  createdAtMs: number;
}

export interface VectorSearchResponse {
  matches: VectorSearchMatch[];
  collection: string;
}

