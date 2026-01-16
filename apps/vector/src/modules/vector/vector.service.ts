import { BadRequestException, Injectable } from '@nestjs/common';

import { QdrantService } from './qdrant.service';

export interface UpsertRequest {
  orgId: string;
  embeddingModel: string;
  points: {
    processedItemId: string;
    itemMetaId: string;
    createdAtMs: number;
    vector: number[];
  }[];
}

export interface SearchRequest {
  orgId: string;
  embeddingModel: string;
  vector: number[];
  limit?: number;
  minScore?: number;
  lookbackMs?: number;
}

@Injectable()
export class VectorService {
  constructor(private readonly qdrant: QdrantService) {}

  async upsert(request: UpsertRequest) {
    if (request.points.length > 0) {
      const vectorSize = request.points[0]?.vector.length ?? 0;
      const mismatch = request.points.findIndex((point) => point.vector.length !== vectorSize);
      if (mismatch !== -1) {
        throw new BadRequestException('All vectors must share the same dimension');
      }
    }

    return await this.qdrant.upsertPoints({
      orgId: request.orgId,
      embeddingModel: request.embeddingModel,
      points: request.points,
    });
  }

  async search(request: SearchRequest) {
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);
    const minScore =
      typeof request.minScore === 'number' && Number.isFinite(request.minScore)
        ? request.minScore
        : undefined;
    return await this.qdrant.search({
      orgId: request.orgId,
      embeddingModel: request.embeddingModel,
      vector: request.vector,
      limit,
      minScore,
      lookbackMs: request.lookbackMs,
    });
  }
}
