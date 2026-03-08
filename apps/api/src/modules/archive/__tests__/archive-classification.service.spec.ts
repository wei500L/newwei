jest.mock('@modular/utils', () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { createHash } from 'node:crypto';

import { ArchiveClassificationService } from '../archive-classification.service';
import type { ArchiveHybridClassificationInput } from '../archive-classification.service';
import {
  ARCHIVE_CLASSIFICATION_PIPELINE_VERSION,
  ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
  ARCHIVE_CLASSIFICATION_TEXT_VERSION,
  ARCHIVE_VERTICAL_ANCHORS,
} from '../archive-classification.constants';
import { ArchiveRegion, ArchiveVertical, createArchiveVerticalScoreMap } from '../archive.types';

const hashText = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const makeRuleContext = (
  ruleScores = {
    ...createArchiveVerticalScoreMap(),
    [ArchiveVertical.EAST_SEA]: 1,
  },
) => ({
  region: ArchiveRegion.APAC,
  ruleVertical: ArchiveVertical.EAST_SEA,
  countryCode: 'JPN',
  countryLabel: 'Japan',
  entityTags: ['Japan'],
  ruleScores,
});

const makeInput = (
  overrides: Partial<ArchiveHybridClassificationInput> = {},
): ArchiveHybridClassificationInput => ({
  processedArticleId: 'processed-1',
  articleId: 'article-1',
  title: 'Japan updates East China Sea posture',
  summary: 'Tokyo reviews maritime security coordination.',
  topics: ['east china sea', 'security'],
  entities: [{ name: 'Japan' }],
  location: 'Japan',
  ruleContext: makeRuleContext(),
  ...overrides,
});

const makePrismaMock = () => ({
  archiveArticleClassification: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(undefined),
  },
  archiveVerticalAnchorEmbedding: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(undefined),
  },
  $transaction: jest.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
});

const makeLiteLlmMock = () => ({
  getEmbeddingModel: jest.fn().mockResolvedValue('embedding-model'),
  getRerankModel: jest.fn().mockResolvedValue('rerank-model'),
  embedding: jest.fn(),
  rerank: jest.fn(),
});

describe('ArchiveClassificationService', () => {
  it('fuses rule + embedding + rerank and returns the top vertical', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    liteLlm.embedding
      .mockResolvedValueOnce({
        model: 'embedding-model',
        data: [
          { index: 0, embedding: [1, 0, 0, 0, 0] },
          { index: 1, embedding: [0, 1, 0, 0, 0] },
          { index: 2, embedding: [0, 0, 1, 0, 0] },
          { index: 3, embedding: [0, 0, 0, 1, 0] },
          { index: 4, embedding: [0, 0, 0, 0, 1] },
        ],
      })
      .mockResolvedValueOnce({
        model: 'embedding-model',
        data: [{ index: 0, embedding: [1, 0, 0, 0, 0] }],
      });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [
        { index: 0, score: 0.95 },
        { index: 1, score: 0.4 },
        { index: 2, score: 0.2 },
      ],
    });

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.classifyHybrid('org-1', makeInput());

    expect(result.vertical).toBe(ArchiveVertical.EAST_SEA);
    expect(result.ruleScores[ArchiveVertical.EAST_SEA]).toBe(1);
    expect(result.embeddingScores[ArchiveVertical.EAST_SEA]).toBe(1);
    expect(result.embeddingScores[ArchiveVertical.SOUTH_SEA]).toBe(0.5);
    expect(result.rerankScores[ArchiveVertical.EAST_SEA]).toBe(1);
    expect(result.rerankScores[ArchiveVertical.DOMESTIC_AFFAIRS]).toBe(0);
    expect(result.fusedScores[ArchiveVertical.EAST_SEA]).toBeGreaterThan(
      result.fusedScores[ArchiveVertical.SOUTH_SEA],
    );
    expect(prisma.archiveVerticalAnchorEmbedding.upsert).toHaveBeenCalledTimes(5);
    expect(prisma.archiveArticleClassification.upsert).toHaveBeenCalledTimes(1);
  });

  it('reuses persisted classifications when versions and hash match', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    const input = makeInput();
    const classificationText = [
      'Title: Japan updates East China Sea posture',
      'Summary: Tokyo reviews maritime security coordination.',
      'Topics: east china sea | security',
      'Entities: Japan',
      'Location: Japan',
    ].join('\n');
    prisma.archiveArticleClassification.findMany.mockResolvedValue([
      {
        processedArticleId: input.processedArticleId,
        articleId: input.articleId,
        region: ArchiveRegion.APAC,
        vertical: ArchiveVertical.EAST_SEA,
        ruleScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        embeddingScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        rerankScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        fusedScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        classificationTextHash: hashText(classificationText),
        classificationTextVersion: ARCHIVE_CLASSIFICATION_TEXT_VERSION,
        taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
        pipelineVersion: ARCHIVE_CLASSIFICATION_PIPELINE_VERSION,
        embeddingModel: 'embedding-model',
        rerankModel: 'rerank-model',
      },
    ]);

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.classifyHybrid('org-1', input);

    expect(result.vertical).toBe(ArchiveVertical.EAST_SEA);
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(liteLlm.rerank).not.toHaveBeenCalled();
    expect(prisma.archiveArticleClassification.upsert).not.toHaveBeenCalled();
  });

  it('reads persisted classifications even when active models are unavailable', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    liteLlm.getEmbeddingModel.mockResolvedValue(undefined);
    liteLlm.getRerankModel.mockResolvedValue(undefined);

    const input = makeInput();
    const classificationText = [
      'Title: Japan updates East China Sea posture',
      'Summary: Tokyo reviews maritime security coordination.',
      'Topics: east china sea | security',
      'Entities: Japan',
      'Location: Japan',
    ].join('\n');
    prisma.archiveArticleClassification.findMany.mockResolvedValue([
      {
        processedArticleId: input.processedArticleId,
        articleId: input.articleId,
        region: ArchiveRegion.APAC,
        vertical: ArchiveVertical.EAST_SEA,
        ruleScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        embeddingScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        rerankScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        fusedScores: { ...createArchiveVerticalScoreMap(), [ArchiveVertical.EAST_SEA]: 1 },
        classificationTextHash: hashText(classificationText),
        classificationTextVersion: ARCHIVE_CLASSIFICATION_TEXT_VERSION,
        taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
        pipelineVersion: ARCHIVE_CLASSIFICATION_PIPELINE_VERSION,
        embeddingModel: 'cached-embedding-model',
        rerankModel: 'cached-rerank-model',
      },
    ]);

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.getCachedHybridBatch('org-1', [input]);

    expect(result.get(input.processedArticleId)?.vertical).toBe(
      ArchiveVertical.EAST_SEA,
    );
    expect(prisma.archiveArticleClassification.findMany).toHaveBeenCalledTimes(1);
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(liteLlm.rerank).not.toHaveBeenCalled();
  });

  it('reuses stored anchor embeddings instead of recalculating them', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    prisma.archiveVerticalAnchorEmbedding.findMany.mockResolvedValue(
      Object.entries(ARCHIVE_VERTICAL_ANCHORS).map(([vertical, anchorText], index) => ({
        vertical,
        anchorTextHash: hashText(anchorText),
        embeddingVector:
          index === 0
            ? [1, 0, 0, 0, 0]
            : index === 1
              ? [-1, 0, 0, 0, 0]
              : index === 2
                ? [0, 0, 1, 0, 0]
                : index === 3
                  ? [0, 0, 0, 1, 0]
                  : [0, 0, 0, 0, 1],
      })),
    );
    liteLlm.embedding.mockResolvedValue({
      model: 'embedding-model',
      data: [{ index: 0, embedding: [1, 0, 0, 0, 0] }],
    });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [{ index: 0, score: 0.9 }],
    });

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    await service.classifyHybrid('org-1', makeInput());

    expect(liteLlm.embedding).toHaveBeenCalledTimes(1);
    expect(prisma.archiveVerticalAnchorEmbedding.upsert).not.toHaveBeenCalled();
  });

  it('fills missing rerank verticals with zero and remains stable on partial results', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    prisma.archiveVerticalAnchorEmbedding.findMany.mockResolvedValue(
      Object.entries(ARCHIVE_VERTICAL_ANCHORS).map(([vertical, anchorText], index) => ({
        vertical,
        anchorTextHash: hashText(anchorText),
        embeddingVector:
          index === 0
            ? [1, 0, 0, 0, 0]
            : index === 1
              ? [-1, 0, 0, 0, 0]
              : index === 2
                ? [0, 0, 1, 0, 0]
                : index === 3
                  ? [0, 0, 0, 1, 0]
                  : [0, 0, 0, 0, 1],
      })),
    );
    liteLlm.embedding.mockResolvedValue({
      model: 'embedding-model',
      data: [{ index: 0, embedding: [0, 1, 0, 0, 0] }],
    });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [{ index: 2, score: 0.8 }],
    });

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.classifyHybrid(
      'org-1',
      makeInput({
        ruleContext: makeRuleContext({
          ...createArchiveVerticalScoreMap(),
          [ArchiveVertical.WEST_FRONT]: 1,
        }),
      }),
    );

    expect(result.rerankScores[ArchiveVertical.WEST_FRONT]).toBe(1);
    expect(result.rerankScores[ArchiveVertical.EAST_SEA]).toBe(0);
    expect(result.rerankScores[ArchiveVertical.SOUTH_SEA]).toBe(0);
    expect(result.vertical).toBe(ArchiveVertical.WEST_FRONT);
  });

  it('uses rerank score as the second tie-break when fused and rule scores tie', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    prisma.archiveVerticalAnchorEmbedding.findMany.mockResolvedValue(
      Object.entries(ARCHIVE_VERTICAL_ANCHORS).map(([vertical, anchorText], index) => ({
        vertical,
        anchorTextHash: hashText(anchorText),
        embeddingVector:
          index === 0
            ? [1, 0, 0, 0, 0]
            : index === 1
              ? [-1, 0, 0, 0, 0]
              : index === 2
                ? [0, 0, 1, 0, 0]
                : index === 3
                  ? [0, 0, 0, 1, 0]
                  : [0, 0, 0, 0, 1],
      })),
    );
    liteLlm.embedding.mockResolvedValue({
      model: 'embedding-model',
      data: [{ index: 0, embedding: [1, 0, 0, 0, 0] }],
    });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [
        { index: 1, score: 1 },
        { index: 0, score: 0 },
      ],
    });

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.classifyHybrid(
      'org-1',
      makeInput({
        ruleContext: makeRuleContext({
          ...createArchiveVerticalScoreMap(),
          [ArchiveVertical.EAST_SEA]: 1,
          [ArchiveVertical.SOUTH_SEA]: 1,
        }),
      }),
    );

    expect(result.fusedScores[ArchiveVertical.EAST_SEA]).toBe(
      result.fusedScores[ArchiveVertical.SOUTH_SEA],
    );
    expect(result.vertical).toBe(ArchiveVertical.SOUTH_SEA);
  });

  it('throws instead of silently degrading when rerank fails', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    liteLlm.embedding
      .mockResolvedValueOnce({
        model: 'embedding-model',
        data: [
          { index: 0, embedding: [1, 0, 0, 0, 0] },
          { index: 1, embedding: [0, 1, 0, 0, 0] },
          { index: 2, embedding: [0, 0, 1, 0, 0] },
          { index: 3, embedding: [0, 0, 0, 1, 0] },
          { index: 4, embedding: [0, 0, 0, 0, 1] },
        ],
      })
      .mockResolvedValueOnce({
        model: 'embedding-model',
        data: [{ index: 0, embedding: [1, 0, 0, 0, 0] }],
      });
    liteLlm.rerank.mockRejectedValue(new Error('rerank down'));

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);

    let thrown: unknown;
    try {
      await service.classifyHybrid('org-1', makeInput());
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe('ARCHIVE_CLASSIFICATION_RERANK_FAILED');
    expect(prisma.archiveArticleClassification.upsert).not.toHaveBeenCalled();
  });
});
