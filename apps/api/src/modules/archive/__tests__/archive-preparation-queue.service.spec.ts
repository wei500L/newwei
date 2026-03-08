jest.mock('@modular/utils', () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
  ensureTraceId: jest.fn(() => 'trace-id'),
  getCurrentTraceId: jest.fn(() => 'trace-id'),
}));

import { ArchivePreparationQueueService } from '../archive-preparation-queue.service';
import { ArchivePreparationState } from '../archive.types';

const makeQueueMock = () => ({
  getJob: jest.fn().mockResolvedValue(null),
  add: jest.fn().mockResolvedValue(undefined),
});

const makeCacheMock = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getMany: jest.fn().mockResolvedValue([]),
  zadd: jest.fn().mockResolvedValue(undefined),
  zcard: jest.fn().mockResolvedValue(0),
  zrange: jest.fn().mockResolvedValue([]),
  zrem: jest.fn().mockResolvedValue(0),
  delMany: jest.fn().mockResolvedValue(0),
});

describe('ArchivePreparationQueueService', () => {
  it('scopes operational status to the requesting org', async () => {
    const queue = makeQueueMock();
    const cache = makeCacheMock();
    cache.zcard.mockResolvedValue(3);
    cache.zrange.mockResolvedValue([
      'archive:preparation:status:digest:org-1:2025-05-01',
      'archive:preparation:status:digest:org-2:2025-05-02',
      'archive:preparation:status:calendar:org-1:2025-05',
    ]);
    cache.getMany.mockResolvedValue([
      {
        scope: 'digest',
        scopeValue: '2025-05-01',
        state: ArchivePreparationState.QUEUED,
        updatedAt: '2025-05-01T00:00:00.000Z',
      },
      {
        orgId: 'org-2',
        scope: 'digest',
        scopeValue: '2025-05-02',
        state: ArchivePreparationState.FAILED,
        updatedAt: '2025-05-02T00:00:00.000Z',
        errorMessage: 'other-org failure',
      },
      {
        orgId: 'org-1',
        scope: 'calendar',
        scopeValue: '2025-05',
        state: ArchivePreparationState.READY,
        updatedAt: '2025-05-03T00:00:00.000Z',
      },
    ]);

    const service = new ArchivePreparationQueueService(queue as any, cache as any);
    const status = await service.getOperationalStatus('org-1');

    expect(status.pending).toBe(1);
    expect(status.counts).toEqual({
      waiting: 1,
      active: 0,
      completed: 1,
      failed: 0,
      delayed: 0,
    });
    expect(status.recentStatuses).toEqual([
      {
        scope: 'calendar',
        scopeValue: '2025-05',
        state: ArchivePreparationState.READY,
        updatedAt: '2025-05-03T00:00:00.000Z',
        errorMessage: null,
      },
      {
        scope: 'digest',
        scopeValue: '2025-05-01',
        state: ArchivePreparationState.QUEUED,
        updatedAt: '2025-05-01T00:00:00.000Z',
        errorMessage: null,
      },
    ]);
  });

  it('does not persist queued status when enqueue fails', async () => {
    const queue = makeQueueMock();
    queue.add.mockRejectedValue(new Error('redis unavailable'));
    const cache = makeCacheMock();
    const service = new ArchivePreparationQueueService(queue as any, cache as any);

    await expect(
      service.ensureDigestCoverage('org-1', '2025-05-01'),
    ).rejects.toThrow('redis unavailable');

    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.zadd).not.toHaveBeenCalled();
  });
});
