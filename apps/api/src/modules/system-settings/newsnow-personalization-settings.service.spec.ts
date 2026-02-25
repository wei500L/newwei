import { ConflictException } from '@nestjs/common';

import { NewsnowPersonalizationSettingsService } from './newsnow-personalization-settings.service';

describe('NewsnowPersonalizationSettingsService', () => {
  const prisma = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    auditLogOutbox: {
      create: jest.fn(),
    },
  } as any;
  const cacheService = {
    hincrby: jest.fn(),
    hgetall: jest.fn(),
    expire: jest.fn(),
  } as any;

  let service: NewsnowPersonalizationSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prisma.systemSetting.upsert = jest.fn();
    prisma.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prisma.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);
    cacheService.hincrby = jest.fn().mockResolvedValue(1);
    cacheService.hgetall = jest.fn().mockResolvedValue({});
    cacheService.expire = jest.fn().mockResolvedValue(1);
    service = new NewsnowPersonalizationSettingsService(prisma, cacheService);
  });

  it('returns defaults when db record does not exist', async () => {
    const settings = await service.getSettings();

    expect(settings).toEqual({
      source: 'default',
      cacheTtlMs: 20_000,
      maxCacheEntries: 2_000,
      throttleWindowMs: 10_000,
      maxRequestsPerWindowPerUser: 40,
      affinitySourceWeight: 0.42,
      behaviorSourceWeight: 0.58,
      focusSourceBonus: 0.35,
      staleTtlStrategy: 'multiplier',
      staleTtlMultiplier: 3,
      staleTtlFixedMs: 60_000,
    });
  });

  it('throws when persisted settings are invalid', async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: 'newsnow_personalization_settings',
      value: {
        cacheTtlMs: 'invalid',
        maxCacheEntries: 100,
        throttleWindowMs: 10000,
        maxRequestsPerWindowPerUser: 10,
      },
    });

    try {
      await service.getSettings();
      throw new Error('expected getSettings to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const conflict = error as ConflictException;
      expect(conflict.getResponse()).toMatchObject({
        code: 'NEWSNOW_PERSONALIZATION_SETTINGS_INVALID',
      });
    }
  });

  it('returns db settings when persisted values are valid', async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: 'newsnow_personalization_settings',
      value: {
        cacheTtlMs: 15000,
        maxCacheEntries: 1800,
        throttleWindowMs: 8000,
        maxRequestsPerWindowPerUser: 25,
        affinitySourceWeight: 0.3,
        behaviorSourceWeight: 0.7,
        focusSourceBonus: 0.5,
        staleTtlStrategy: 'fixed',
        staleTtlMultiplier: 5,
        staleTtlFixedMs: 90000,
      },
    });

    const settings = await service.getSettings();
    expect(settings).toEqual({
      source: 'db',
      cacheTtlMs: 15000,
      maxCacheEntries: 1800,
      throttleWindowMs: 8000,
      maxRequestsPerWindowPerUser: 25,
      affinitySourceWeight: 0.3,
      behaviorSourceWeight: 0.7,
      focusSourceBonus: 0.5,
      staleTtlStrategy: 'fixed',
      staleTtlMultiplier: 5,
      staleTtlFixedMs: 90000,
    });
  });

  it('keeps backward compatibility for old records without stale ttl fields', async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: 'newsnow_personalization_settings',
      value: {
        cacheTtlMs: 15000,
        maxCacheEntries: 1800,
        throttleWindowMs: 8000,
        maxRequestsPerWindowPerUser: 25,
      },
    });

    const settings = await service.getSettings();
    expect(settings).toEqual({
      source: 'db',
      cacheTtlMs: 15000,
      maxCacheEntries: 1800,
      throttleWindowMs: 8000,
      maxRequestsPerWindowPerUser: 25,
      affinitySourceWeight: 0.42,
      behaviorSourceWeight: 0.58,
      focusSourceBonus: 0.35,
      staleTtlStrategy: 'multiplier',
      staleTtlMultiplier: 3,
      staleTtlFixedMs: 60_000,
    });
  });

  it('updates settings and writes audit log', async () => {
    await service.updateSettings('org-1', 'actor-1', {
      cacheTtlMs: 25_000,
      maxCacheEntries: 4_000,
      throttleWindowMs: 12_000,
      maxRequestsPerWindowPerUser: 80,
      affinitySourceWeight: 0.4,
      behaviorSourceWeight: 0.6,
      focusSourceBonus: 0.8,
      staleTtlStrategy: 'multiplier',
      staleTtlMultiplier: 4,
      staleTtlFixedMs: 120_000,
    });

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'newsnow_personalization_settings' },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('rejects invalid update payload', async () => {
    await expect(
      service.updateSettings('org-1', 'actor-1', {
        cacheTtlMs: -1,
        maxCacheEntries: 10,
        throttleWindowMs: 100,
        maxRequestsPerWindowPerUser: 0,
        affinitySourceWeight: -0.1,
        behaviorSourceWeight: 0,
        focusSourceBonus: -1,
        staleTtlStrategy: 'multiplier',
        staleTtlMultiplier: 0,
        staleTtlFixedMs: 10,
      }),
    ).rejects.toThrow('cacheTtlMs must be an integer between 0 and 300000');

    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('builds runtime metrics snapshot with rates', async () => {
    cacheService.hgetall = jest
      .fn()
      .mockResolvedValueOnce({
        requestCount: '100',
        cacheHitFreshCount: '40',
        cacheHitStaleCount: '10',
        throttleLimitedCount: '12',
        throttleRejectedCount: '2',
        trimCount: '3',
        trimEvictedCount: '30',
      })
      .mockResolvedValueOnce({
        requestCount: '50',
        cacheHitFreshCount: '20',
        cacheHitStaleCount: '5',
        throttleLimitedCount: '3',
        throttleRejectedCount: '1',
        trimCount: '1',
        trimEvictedCount: '5',
      });

    const snapshot = await service.getRuntimeMetricsSnapshot(2);
    expect(snapshot.windowDays).toBe(2);
    expect(snapshot.totals.requestCount).toBe(150);
    expect(snapshot.totals.cacheHitTotalCount).toBe(75);
    expect(snapshot.totals.cacheHitRate).toBe(0.5);
    expect(snapshot.totals.throttleLimitedCount).toBe(15);
    expect(snapshot.totals.throttleRate).toBe(0.1);
    expect(snapshot.totals.trimCount).toBe(4);
    expect(snapshot.totals.trimEvictedCount).toBe(35);
  });
});
