import { ContentSubscriptionKind } from '@prisma/client';

import { UserContentSubscriptionsService } from '../user-content-subscriptions.service';

describe('UserContentSubscriptionsService', () => {
  it('falls back to top catalog items when behavior profile is empty', async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({ id: 'migrated' }),
      },
      userContentSubscription: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      contentSubscriptionCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            kind: ContentSubscriptionKind.entity,
            normalizedValue: 'nvidia',
            displayValue: 'NVIDIA',
            count: 25,
            lastSeenAt: new Date('2026-03-06T00:00:00.000Z'),
            taxonomyPath: 'tech/semiconductor/supply-chain',
            metadata: null,
            embeddingVector: null,
          },
          {
            kind: ContentSubscriptionKind.topic,
            normalizedValue: 'ai chips',
            displayValue: 'AI chips',
            count: 18,
            lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
            taxonomyPath: 'tech/ai/model-release',
            metadata: null,
            embeddingVector: null,
          },
        ]),
      },
    };
    const cache = {
      wrap: jest.fn().mockResolvedValue({ syncedAt: '2026-03-06T00:00:00.000Z' }),
    };
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        taxonomyVersion: 'news-taxonomy-v1',
        taxonomy: [
          {
            path: 'tech/ai/model-release',
            displayName: 'AI Model Release',
            description: 'AI model launches and updates',
            legacyCategory: 'ai',
            keywords: ['ai'],
            synonyms: ['llm'],
          },
          {
            path: 'tech/semiconductor/supply-chain',
            displayName: 'Semiconductor Supply Chain',
            description: 'Chip manufacturing and supply chain',
            legacyCategory: 'tech',
            keywords: ['chip'],
            synonyms: ['semiconductor'],
          },
        ],
      }),
    };
    const liteLlm = {
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const behavior = {
      getProfile: jest.fn().mockResolvedValue({
        actions: {},
        sources: {},
        topics: {},
        entities: {},
        items: {},
        events: {},
        domains: {},
      }),
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      cache as any,
      settings as any,
      liteLlm as any,
      behavior as any,
    );

    const result = await service.listRecommendations('org-1', 'user-1', 5);

    expect(result.items.map((item) => item.displayValue)).toEqual(['NVIDIA', 'AI chips']);
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(liteLlm.rerank).not.toHaveBeenCalled();
  });
});
