import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { QdrantService } from './qdrant.service';
import { VectorService } from './vector.service';

describe('VectorService', () => {
  it('rejects upsert points with mixed vector dimensions', async () => {
    const qdrant = { upsertPoints: vi.fn(), search: vi.fn() };
    const service = new VectorService(qdrant as unknown as QdrantService);

    await expect(
      service.upsert({
        orgId: 'org-1',
        embeddingModel: 'text-embedding-3-small',
        points: [
          {
            processedItemId: 'p1',
            itemMetaId: 'm1',
            createdAtMs: 1,
            vector: [0.1, 0.2],
          },
          {
            processedItemId: 'p2',
            itemMetaId: 'm2',
            createdAtMs: 2,
            vector: [0.1],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(qdrant.upsertPoints).not.toHaveBeenCalled();
  });

  it('clamps search limit to 1–500 and forwards orgId', async () => {
    const qdrant = {
      upsertPoints: vi.fn(),
      search: vi.fn().mockResolvedValue({ collection: 'c', matches: [] }),
    };
    const service = new VectorService(qdrant as unknown as QdrantService);

    await service.search({
      orgId: 'org-1',
      embeddingModel: 'text-embedding-3-small',
      vector: [0.1, 0.2],
      limit: 0,
    });
    expect(qdrant.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ orgId: 'org-1', limit: 1 }),
    );

    await service.search({
      orgId: 'org-1',
      embeddingModel: 'text-embedding-3-small',
      vector: [0.1, 0.2],
      limit: 900,
    });
    expect(qdrant.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ orgId: 'org-1', limit: 500 }),
    );
  });
});
