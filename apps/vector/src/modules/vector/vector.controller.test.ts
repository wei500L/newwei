import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { VectorController } from './vector.controller';
import type { VectorService } from './vector.service';

describe('VectorController', () => {
  it('rejects an invalid upsert body', async () => {
    const vector = { upsert: vi.fn(), search: vi.fn() };
    const controller = new VectorController(vector as unknown as VectorService);

    await expect(controller.upsert({ orgId: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(vector.upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid search body', async () => {
    const vector = { upsert: vi.fn(), search: vi.fn() };
    const controller = new VectorController(vector as unknown as VectorService);

    await expect(
      controller.search({ orgId: 'org-1', embeddingModel: 'm' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(vector.search).not.toHaveBeenCalled();
  });

  it('forwards a valid search request', async () => {
    const vector = {
      upsert: vi.fn(),
      search: vi.fn().mockResolvedValue({ collection: 'c', matches: [] }),
    };
    const controller = new VectorController(vector as unknown as VectorService);

    await controller.search({
      orgId: 'org-1',
      embeddingModel: 'text-embedding-3-small',
      vector: [0.1, 0.2],
      limit: 10,
    });
    expect(vector.search).toHaveBeenCalledWith({
      orgId: 'org-1',
      embeddingModel: 'text-embedding-3-small',
      vector: [0.1, 0.2],
      limit: 10,
    });
  });
});
