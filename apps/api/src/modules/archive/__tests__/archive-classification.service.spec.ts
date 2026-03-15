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
} from '../archive-classification.constants';
import {
  type ArchiveRuleVerticalSignals,
} from '../archive.classifier';
import { ARCHIVE_VERTICAL_ANCHOR_ENTRIES } from '../archive-taxonomy';
import { ArchiveRegion, ArchiveVertical, createArchiveVerticalScoreMap } from '../archive.types';

const hashText = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const ANCHOR_VARIANTS = ARCHIVE_VERTICAL_ANCHOR_ENTRIES;

const VERTICAL_VECTORS: Record<ArchiveVertical, number[]> = {
  [ArchiveVertical.EAST_SEA]: [1, 0, 0, 0, 0],
  [ArchiveVertical.SOUTH_SEA]: [0, 1, 0, 0, 0],
  [ArchiveVertical.WEST_FRONT]: [0, 0, 1, 0, 0],
  [ArchiveVertical.FOREIGN_AFFAIRS]: [0, 0, 0, 1, 0],
  [ArchiveVertical.DOMESTIC_AFFAIRS]: [0, 0, 0, 0, 1],
};

const makeAnchorEmbeddingResponse = () => ({
  model: 'embedding-model',
  data: ANCHOR_VARIANTS.map((anchor, index) => ({
    index,
    embedding: VERTICAL_VECTORS[anchor.vertical],
  })),
});

const makeStoredAnchorRows = () =>
  ANCHOR_VARIANTS.map((anchor) => ({
    vertical: anchor.vertical,
    anchorTextHash: hashText(anchor.anchorText),
    embeddingVector: VERTICAL_VECTORS[anchor.vertical],
  }));

const firstAnchorIndexFor = (vertical: ArchiveVertical) =>
  ANCHOR_VARIANTS.findIndex((anchor) => anchor.vertical === vertical);

const makeVerticalSignal = (
  overrides: Partial<ArchiveRuleVerticalSignals> = {},
): ArchiveRuleVerticalSignals => ({
  countryMatched: false,
  matchedCountries: [],
  matchedStrongKeywords: [],
  matchedWeakKeywords: [],
  excludedKeywords: [],
  conflictKeywords: [],
  ...overrides,
});

const makeVerticalSignalMap = (
  overrides: Partial<Record<ArchiveVertical, Partial<ArchiveRuleVerticalSignals>>> = {},
) => ({
  [ArchiveVertical.EAST_SEA]: makeVerticalSignal(overrides[ArchiveVertical.EAST_SEA]),
  [ArchiveVertical.SOUTH_SEA]: makeVerticalSignal(overrides[ArchiveVertical.SOUTH_SEA]),
  [ArchiveVertical.WEST_FRONT]: makeVerticalSignal(overrides[ArchiveVertical.WEST_FRONT]),
  [ArchiveVertical.FOREIGN_AFFAIRS]: makeVerticalSignal(overrides[ArchiveVertical.FOREIGN_AFFAIRS]),
  [ArchiveVertical.DOMESTIC_AFFAIRS]: makeVerticalSignal(overrides[ArchiveVertical.DOMESTIC_AFFAIRS]),
});

const makeRuleContext = (
  ruleScores = {
    ...createArchiveVerticalScoreMap(),
    [ArchiveVertical.EAST_SEA]: 1,
  },
  overrides?: Partial<{
    countryMatchedVerticals: ArchiveVertical[];
    verticalSignals: Partial<Record<ArchiveVertical, Partial<ArchiveRuleVerticalSignals>>>;
    matchedCountries: string[];
    matchedKeywords: string[];
    suppressedKeywords: string[];
  }>,
) => ({
  region: ArchiveRegion.APAC,
  ruleVertical: ArchiveVertical.EAST_SEA,
  countryCode: 'JPN',
  countryLabel: 'Japan',
  entityTags: ['Japan'],
  ruleScores,
  matchedCountries: overrides?.matchedCountries ?? ['【东海】 Japan'],
  matchedKeywords: overrides?.matchedKeywords ?? ['【东海】 east china sea'],
  suppressedKeywords: overrides?.suppressedKeywords ?? [],
  countryMatchedVerticals:
    overrides?.countryMatchedVerticals ?? [ArchiveVertical.EAST_SEA],
  verticalSignals: makeVerticalSignalMap({
    [ArchiveVertical.EAST_SEA]: {
      countryMatched: true,
      matchedCountries: ['Japan'],
      matchedStrongKeywords: ['east china sea'],
    },
    ...overrides?.verticalSignals,
  }),
});

const makeInput = (
  overrides: Partial<ArchiveHybridClassificationInput> = {},
): ArchiveHybridClassificationInput => ({
  processedArticleId: 'processed-1',
  articleId: 'article-1',
  title: 'Japan updates East China Sea posture',
  summary: 'Tokyo reviews maritime security coordination.',
  source: 'Kyodo',
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
      .mockResolvedValueOnce(makeAnchorEmbeddingResponse())
      .mockResolvedValueOnce({
        model: 'embedding-model',
        data: [{ index: 0, embedding: VERTICAL_VECTORS[ArchiveVertical.EAST_SEA] }],
      });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [
        { index: firstAnchorIndexFor(ArchiveVertical.EAST_SEA), score: 0.95 },
        { index: firstAnchorIndexFor(ArchiveVertical.SOUTH_SEA), score: 0.4 },
        { index: firstAnchorIndexFor(ArchiveVertical.WEST_FRONT), score: 0.2 },
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
    expect(prisma.archiveVerticalAnchorEmbedding.upsert).toHaveBeenCalledTimes(
      ANCHOR_VARIANTS.length,
    );
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
      'Source: Kyodo',
      'Country hint: Japan',
      'Region hint: APAC',
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
      'Source: Kyodo',
      'Country hint: Japan',
      'Region hint: APAC',
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
      makeStoredAnchorRows(),
    );
    liteLlm.embedding.mockResolvedValue({
      model: 'embedding-model',
      data: [{ index: 0, embedding: VERTICAL_VECTORS[ArchiveVertical.EAST_SEA] }],
    });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [{ index: firstAnchorIndexFor(ArchiveVertical.EAST_SEA), score: 0.9 }],
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
      makeStoredAnchorRows(),
    );
    liteLlm.embedding.mockResolvedValue({
      model: 'embedding-model',
      data: [{ index: 0, embedding: VERTICAL_VECTORS[ArchiveVertical.SOUTH_SEA] }],
    });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [{ index: firstAnchorIndexFor(ArchiveVertical.WEST_FRONT), score: 0.8 }],
    });

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.classifyHybrid(
      'org-1',
      makeInput({
        ruleContext: makeRuleContext(
          {
            ...createArchiveVerticalScoreMap(),
            [ArchiveVertical.WEST_FRONT]: 1,
          },
          {
            matchedCountries: ['【西面】 Pakistan'],
            matchedKeywords: ['【西面】 kashmir'],
            countryMatchedVerticals: [ArchiveVertical.WEST_FRONT],
            verticalSignals: {
              [ArchiveVertical.WEST_FRONT]: {
                countryMatched: true,
                matchedCountries: ['Pakistan'],
                matchedStrongKeywords: ['kashmir'],
              },
            },
          },
        ),
      }),
    );

    expect(result.rerankScores[ArchiveVertical.WEST_FRONT]).toBe(1);
    expect(result.rerankScores[ArchiveVertical.EAST_SEA]).toBe(0);
    expect(result.rerankScores[ArchiveVertical.SOUTH_SEA]).toBe(0);
    expect(result.vertical).toBe(ArchiveVertical.WEST_FRONT);
  });

  it('falls back to the strong country rule when the semantic winner is marginal', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    prisma.archiveVerticalAnchorEmbedding.findMany.mockResolvedValue(
      makeStoredAnchorRows(),
    );
    liteLlm.embedding.mockResolvedValue({
      model: 'embedding-model',
      data: [{ index: 0, embedding: VERTICAL_VECTORS[ArchiveVertical.SOUTH_SEA] }],
    });
    liteLlm.rerank.mockResolvedValue({
      model: 'rerank-model',
      results: [{ index: firstAnchorIndexFor(ArchiveVertical.SOUTH_SEA), score: 0.95 }],
    });

    const service = new ArchiveClassificationService(prisma as any, liteLlm as any);
    const result = await service.classifyHybrid('org-1', makeInput());

    expect(result.embeddingScores[ArchiveVertical.SOUTH_SEA]).toBe(1);
    expect(result.rerankScores[ArchiveVertical.SOUTH_SEA]).toBe(1);
    expect(result.vertical).toBe(ArchiveVertical.EAST_SEA);
  });

  it('throws instead of silently degrading when rerank fails', async () => {
    const prisma = makePrismaMock();
    const liteLlm = makeLiteLlmMock();
    liteLlm.embedding
      .mockResolvedValueOnce(makeAnchorEmbeddingResponse())
      .mockResolvedValueOnce({
        model: 'embedding-model',
        data: [{ index: 0, embedding: VERTICAL_VECTORS[ArchiveVertical.EAST_SEA] }],
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
