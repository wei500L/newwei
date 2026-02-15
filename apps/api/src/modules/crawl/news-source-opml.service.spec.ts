import { Prisma } from '@prisma/client';

import { NewsSourceOpmlService } from './news-source-opml.service';

describe('NewsSourceOpmlService', () => {
  it('lists presets with parsed entry count', () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = new NewsSourceOpmlService(prisma);
    const presets = service.listPresets();

    expect(presets.length).toBeGreaterThan(0);
    expect(presets[0]?.id).toBe('hn_popular_blogs_2025');
    expect((presets[0]?.entryCount ?? 0) > 50).toBe(true);
  });

  it('previews OPML entries and marks existing URLs as duplicates', async () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn().mockResolvedValue([
          { url: 'https://simonwillison.net' },
        ]),
        create: jest.fn(),
      },
    } as any;

    const service = new NewsSourceOpmlService(prisma);
    const result = await service.preview({
      orgId: 'org-1',
      presetId: 'hn_popular_blogs_2025',
      defaultLanguage: 'zh',
    });

    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.summary.duplicates).toBeGreaterThan(0);

    const existing = result.entries.find(
      (entry) => entry.url === 'https://simonwillison.net',
    );
    expect(existing).toEqual(
      expect.objectContaining({
        alreadyExists: true,
        enabled: false,
      }),
    );
  });

  it('imports entries with skip-on-duplicate behavior and report stats', async () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn().mockResolvedValue([{ url: 'https://existing.test' }]),
        create: jest.fn().mockResolvedValue({
          id: 'source-1',
          name: 'New Source',
          url: 'https://new-source.test',
        }),
      },
    } as any;

    const service = new NewsSourceOpmlService(prisma);
    const report = await service.import({
      orgId: 'org-1',
      entries: [
        {
          name: 'Existing Source',
          url: 'https://existing.test',
          feedUrl: 'https://existing.test/rss.xml',
          language: 'zh',
          enabled: true,
        },
        {
          name: 'New Source',
          url: 'https://new-source.test',
          feedUrl: 'https://new-source.test/rss.xml',
          language: 'en',
          enabled: true,
        },
        {
          name: 'Invalid Source',
          url: 'not-a-url',
          feedUrl: 'https://invalid.test/rss.xml',
          language: 'zh',
          enabled: true,
        },
      ],
      conflictPolicy: 'skip',
      runtimeProfile: 'steady',
    });

    expect(prisma.newsSource.create).toHaveBeenCalledTimes(1);
    expect(report.summary.total).toBe(3);
    expect(report.summary.enabled).toBe(3);
    expect(report.summary.created).toBe(1);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.created[0]).toEqual(
      expect.objectContaining({
        id: 'source-1',
        url: 'https://new-source.test',
      }),
    );
  });

  it('treats database unique conflict as skipped duplicate', async () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: '0',
            meta: { target: ['NewsSource_orgId_url_key'] },
          }),
        ),
      },
    } as any;

    const service = new NewsSourceOpmlService(prisma);
    const report = await service.import({
      orgId: 'org-1',
      entries: [
        {
          name: 'Duplicate Source',
          url: 'https://duplicate.test',
          feedUrl: 'https://duplicate.test/rss.xml',
          language: 'zh',
          enabled: true,
        },
      ],
      conflictPolicy: 'skip',
      runtimeProfile: 'steady',
    });

    expect(report.summary.created).toBe(0);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(report.skipped[0]).toEqual(
      expect.objectContaining({ reason: 'duplicate' }),
    );
  });
});
