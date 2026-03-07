import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { createLogger } from '@modular/utils';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { PrismaService } from '../config/prisma.service';
import { LiteLlmService } from '../news-pipeline/litellm.service';

import {
  ARCHIVE_CLASSIFICATION_EMBEDDING_BATCH_SIZE,
  ARCHIVE_CLASSIFICATION_EMPTY_TEXT,
  ARCHIVE_CLASSIFICATION_PERSIST_BATCH_SIZE,
  ARCHIVE_CLASSIFICATION_PIPELINE_VERSION,
  ARCHIVE_CLASSIFICATION_RERANK_CONCURRENCY,
  ARCHIVE_CLASSIFICATION_SOURCE,
  ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
  ARCHIVE_CLASSIFICATION_TEXT_VERSION,
  ARCHIVE_FUSION_WEIGHTS,
  ARCHIVE_VERTICAL_ANCHORS,
} from './archive-classification.constants';
import {
  type ArchiveClassifierInput,
  type ArchiveRuleClassificationSignals,
} from './archive.classifier';
import {
  ARCHIVE_VERTICAL_ORDER,
  ArchiveRegion,
  ArchiveVertical,
  type ArchiveVerticalScores,
  createArchiveVerticalScoreMap,
} from './archive.types';

const SCORE_TIE_EPSILON = 1e-9;
const VERTICAL_ORDER_INDEX = new Map<ArchiveVertical, number>(
  ARCHIVE_VERTICAL_ORDER.map((vertical, index) => [vertical, index]),
);

interface ClassifiedArchiveInput extends ArchiveClassifierInput {
  processedArticleId: string;
  articleId: string;
  ruleContext: ArchiveRuleClassificationSignals;
}

interface PreparedArchiveInput extends ClassifiedArchiveInput {
  classificationText: string;
  classificationTextHash: string;
}

export interface ArchiveClassificationRuntimeOptions {
  jobBatchSize: number;
  embeddingBatchSize: number;
  embeddingMaxConcurrency: number;
  rerankMaxConcurrency: number;
}

interface StoredArchiveClassificationRow {
  processedArticleId: string;
  articleId: string;
  region: string;
  vertical: string;
  ruleScores: unknown;
  embeddingScores: unknown;
  rerankScores: unknown;
  fusedScores: unknown;
  classificationTextHash: string;
  classificationTextVersion: string;
  taxonomyVersion: string;
  pipelineVersion: string;
  embeddingModel: string;
  rerankModel: string;
}

export interface ArchiveHybridClassificationInput extends ArchiveClassifierInput {
  processedArticleId: string;
  articleId: string;
  ruleContext: ArchiveRuleClassificationSignals;
}

export interface ArchiveHybridClassificationResult {
  processedArticleId: string;
  articleId: string;
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  countryCode: string | null;
  countryLabel: string;
  entityTags: string[];
  ruleScores: ArchiveVerticalScores;
  embeddingScores: ArchiveVerticalScores;
  rerankScores: ArchiveVerticalScores;
  fusedScores: ArchiveVerticalScores;
  classificationTextHash: string;
  classificationTextVersion: string;
  taxonomyVersion: string;
  pipelineVersion: string;
  embeddingModel: string;
  rerankModel: string;
}

@Injectable()
export class ArchiveClassificationService {
  private readonly logger = createLogger({
    name: 'archive-classification-service',
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly liteLlm: LiteLlmService,
  ) {}

  async classifyHybrid(
    orgId: string,
    input: ArchiveHybridClassificationInput,
  ): Promise<ArchiveHybridClassificationResult> {
    const [result] = await this.classifyHybridBatch(orgId, [input]);
    if (!result) {
      throw this.buildException(
        'ARCHIVE_CLASSIFICATION_FAILED',
        'Archive classification produced no result.',
        {
          orgId,
          processedArticleId: input.processedArticleId,
          articleId: input.articleId,
        },
      );
    }
    return result;
  }

  async classifyHybridBatch(
    orgId: string,
    inputs: ArchiveHybridClassificationInput[],
    options?: Partial<ArchiveClassificationRuntimeOptions>,
  ): Promise<ArchiveHybridClassificationResult[]> {
    if (inputs.length === 0) {
      return [];
    }

    const runtime = this.resolveRuntimeOptions(options);

    const [embeddingModel, rerankModel] = await Promise.all([
      this.liteLlm.getEmbeddingModel(),
      this.liteLlm.getRerankModel(),
    ]);

    if (!embeddingModel) {
      throw this.buildException(
        'ARCHIVE_CLASSIFICATION_EMBEDDING_UNAVAILABLE',
        'Archive classification embedding model is not configured.',
        {
          orgId,
          layer: 'embedding',
          processedArticleIds: inputs.map((input) => input.processedArticleId),
        },
      );
    }

    if (!rerankModel) {
      throw this.buildException(
        'ARCHIVE_CLASSIFICATION_RERANK_UNAVAILABLE',
        'Archive classification rerank model is not configured.',
        {
          orgId,
          layer: 'rerank',
          processedArticleIds: inputs.map((input) => input.processedArticleId),
        },
      );
    }

    const preparedInputs = inputs.map((input) => {
      const classificationText = this.buildClassificationText(input);
      return {
        ...input,
        classificationText,
        classificationTextHash: this.hashText(classificationText),
      } satisfies PreparedArchiveInput;
    });

    const cachedResults = await this.loadCachedResults(
      orgId,
      preparedInputs,
      embeddingModel,
      rerankModel,
    );
    const missingInputs = preparedInputs.filter(
      (input) => !cachedResults.has(input.processedArticleId),
    );

    if (missingInputs.length > 0) {
      const anchorVectors = await this.loadAnchorEmbeddings(
        orgId,
        embeddingModel,
        missingInputs,
      );
      for (
        let start = 0;
        start < missingInputs.length;
        start += runtime.jobBatchSize
      ) {
        const slice = missingInputs.slice(start, start + runtime.jobBatchSize);
        const embeddingScores = await this.computeEmbeddingScores(
          orgId,
          slice,
          embeddingModel,
          anchorVectors,
          runtime,
        );
        const rerankScores = await this.computeRerankScores(
          orgId,
          slice,
          rerankModel,
          runtime,
        );

        const computedResults = slice.map((input) => {
          const embeddingScoreMap =
            embeddingScores.get(input.processedArticleId) ?? createArchiveVerticalScoreMap();
          const rerankScoreMap =
            rerankScores.get(input.processedArticleId) ?? createArchiveVerticalScoreMap();
          const fusedScores = this.combineScores(
            input.ruleContext.ruleScores,
            embeddingScoreMap,
            rerankScoreMap,
          );

          return {
            processedArticleId: input.processedArticleId,
            articleId: input.articleId,
            region: input.ruleContext.region,
            vertical: this.selectVertical(
              fusedScores,
              input.ruleContext.ruleScores,
              rerankScoreMap,
            ),
            countryCode: input.ruleContext.countryCode,
            countryLabel: input.ruleContext.countryLabel,
            entityTags: input.ruleContext.entityTags,
            ruleScores: input.ruleContext.ruleScores,
            embeddingScores: embeddingScoreMap,
            rerankScores: rerankScoreMap,
            fusedScores,
            classificationTextHash: input.classificationTextHash,
            classificationTextVersion: ARCHIVE_CLASSIFICATION_TEXT_VERSION,
            taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
            pipelineVersion: ARCHIVE_CLASSIFICATION_PIPELINE_VERSION,
            embeddingModel,
            rerankModel,
          } satisfies ArchiveHybridClassificationResult;
        });

        await this.persistResults(orgId, computedResults);
        for (const result of computedResults) {
          cachedResults.set(result.processedArticleId, result);
        }
      }
    }

    return preparedInputs.map((input) => {
      const result = cachedResults.get(input.processedArticleId);
      if (!result) {
        throw this.buildException(
          'ARCHIVE_CLASSIFICATION_FAILED',
          'Archive classification result is missing after batch processing.',
          {
            orgId,
            processedArticleId: input.processedArticleId,
            articleId: input.articleId,
          },
        );
      }
      return result;
    });
  }

  async getCachedHybridBatch(
    orgId: string,
    inputs: ArchiveHybridClassificationInput[],
  ): Promise<Map<string, ArchiveHybridClassificationResult>> {
    if (inputs.length === 0) {
      return new Map();
    }

    const [embeddingModel, rerankModel] = await Promise.all([
      this.liteLlm.getEmbeddingModel(),
      this.liteLlm.getRerankModel(),
    ]);
    if (!embeddingModel || !rerankModel) {
      return new Map();
    }

    const preparedInputs = inputs.map((input) => {
      const classificationText = this.buildClassificationText(input);
      return {
        ...input,
        classificationText,
        classificationTextHash: this.hashText(classificationText),
      } satisfies PreparedArchiveInput;
    });

    return this.loadCachedResults(
      orgId,
      preparedInputs,
      embeddingModel,
      rerankModel,
    );
  }

  private async loadCachedResults(
    orgId: string,
    inputs: PreparedArchiveInput[],
    embeddingModel: string,
    rerankModel: string,
  ): Promise<Map<string, ArchiveHybridClassificationResult>> {
    const rows = (await this.prisma.archiveArticleClassification.findMany({
      where: {
        orgId,
        processedArticleId: {
          in: inputs.map((input) => input.processedArticleId),
        },
      },
      select: {
        processedArticleId: true,
        articleId: true,
        region: true,
        vertical: true,
        ruleScores: true,
        embeddingScores: true,
        rerankScores: true,
        fusedScores: true,
        classificationTextHash: true,
        classificationTextVersion: true,
        taxonomyVersion: true,
        pipelineVersion: true,
        embeddingModel: true,
        rerankModel: true,
      },
    })) as StoredArchiveClassificationRow[];

    const inputById = new Map(
      inputs.map((input) => [input.processedArticleId, input]),
    );
    const results = new Map<string, ArchiveHybridClassificationResult>();

    for (const row of rows) {
      const input = inputById.get(row.processedArticleId);
      if (!input) {
        continue;
      }
      if (
        row.classificationTextHash !== input.classificationTextHash ||
        row.classificationTextVersion !== ARCHIVE_CLASSIFICATION_TEXT_VERSION ||
        row.taxonomyVersion !== ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION ||
        row.pipelineVersion !== ARCHIVE_CLASSIFICATION_PIPELINE_VERSION ||
        row.embeddingModel !== embeddingModel ||
        row.rerankModel !== rerankModel
      ) {
        continue;
      }

      const region = this.parseRegion(row.region);
      const vertical = this.parseVertical(row.vertical);
      if (!region || !vertical) {
        continue;
      }

      results.set(row.processedArticleId, {
        processedArticleId: row.processedArticleId,
        articleId: row.articleId,
        region,
        vertical,
        countryCode: input.ruleContext.countryCode,
        countryLabel: input.ruleContext.countryLabel,
        entityTags: input.ruleContext.entityTags,
        ruleScores: this.parseScoreMap(row.ruleScores),
        embeddingScores: this.parseScoreMap(row.embeddingScores),
        rerankScores: this.parseScoreMap(row.rerankScores),
        fusedScores: this.parseScoreMap(row.fusedScores),
        classificationTextHash: row.classificationTextHash,
        classificationTextVersion: row.classificationTextVersion,
        taxonomyVersion: row.taxonomyVersion,
        pipelineVersion: row.pipelineVersion,
        embeddingModel: row.embeddingModel,
        rerankModel: row.rerankModel,
      });
    }

    return results;
  }

  private async loadAnchorEmbeddings(
    orgId: string,
    embeddingModel: string,
    inputs: PreparedArchiveInput[],
  ): Promise<Map<ArchiveVertical, number[]>> {
    const anchors = ARCHIVE_VERTICAL_ORDER.map((vertical) => ({
      vertical,
      anchorText: ARCHIVE_VERTICAL_ANCHORS[vertical],
      anchorTextHash: this.hashText(ARCHIVE_VERTICAL_ANCHORS[vertical]),
    }));

    const rows = await this.prisma.archiveVerticalAnchorEmbedding.findMany({
      where: {
        taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
        embeddingModel,
        vertical: { in: ARCHIVE_VERTICAL_ORDER },
      },
      select: {
        vertical: true,
        anchorTextHash: true,
        embeddingVector: true,
      },
    });

    const vectors = new Map<ArchiveVertical, number[]>();
    for (const row of rows) {
      const vertical = this.parseVertical(row.vertical);
      if (!vertical) {
        continue;
      }
      const anchor = anchors.find((entry) => entry.vertical === vertical);
      if (!anchor || row.anchorTextHash !== anchor.anchorTextHash) {
        continue;
      }
      const vector = this.parseVector(row.embeddingVector);
      if (vector.length === 0) {
        continue;
      }
      vectors.set(vertical, vector);
    }

    const missingAnchors = anchors.filter(
      (anchor) => !vectors.has(anchor.vertical),
    );
    if (missingAnchors.length === 0) {
      return vectors;
    }

    let response;
    try {
      response = await this.liteLlm.embedding({
        orgId,
        model: embeddingModel,
        input: missingAnchors.map((anchor) => anchor.anchorText),
        metadata: {
          source: ARCHIVE_CLASSIFICATION_SOURCE,
          layer: 'embedding-anchor',
          orgId,
          taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
        },
      });
    } catch (error) {
      throw this.buildLayerFailureException(
        'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
        'embedding',
        error,
        {
          orgId,
          embeddingModel,
          processedArticleIds: inputs.map((input) => input.processedArticleId),
        },
      );
    }

    const vectorByIndex = new Map<number, number[]>();
    for (const row of response.data ?? []) {
      if (
        !row ||
        typeof row.index !== 'number' ||
        !Array.isArray(row.embedding) ||
        row.embedding.length === 0
      ) {
        continue;
      }
      vectorByIndex.set(row.index, row.embedding);
    }

    const upserts = missingAnchors.map((anchor, index) => {
      const vector = vectorByIndex.get(index);
      if (!vector || vector.length === 0) {
        throw this.buildException(
          'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
          'Archive anchor embedding response is missing a usable vector.',
          {
            orgId,
            layer: 'embedding',
            embeddingModel,
            vertical: anchor.vertical,
            processedArticleIds: inputs.map((input) => input.processedArticleId),
          },
        );
      }
      vectors.set(anchor.vertical, vector);

      return this.prisma.archiveVerticalAnchorEmbedding.upsert({
        where: {
          vertical_taxonomyVersion_embeddingModel_anchorTextHash: {
            vertical: anchor.vertical,
            taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
            embeddingModel,
            anchorTextHash: anchor.anchorTextHash,
          },
        },
        create: {
          vertical: anchor.vertical,
          taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
          anchorText: anchor.anchorText,
          anchorTextHash: anchor.anchorTextHash,
          embeddingModel,
          embeddingVector: toPrismaJsonValue(vector),
        },
        update: {
          anchorText: anchor.anchorText,
          embeddingVector: toPrismaJsonValue(vector),
        },
      });
    });

    await this.runPrismaWritesInBatches(
      upserts,
      ARCHIVE_CLASSIFICATION_PERSIST_BATCH_SIZE,
      (error) =>
        this.buildLayerFailureException(
          'ARCHIVE_CLASSIFICATION_PERSIST_FAILED',
          'embedding',
          error,
          {
            orgId,
            embeddingModel,
            processedArticleIds: inputs.map((input) => input.processedArticleId),
          },
        ),
    );

    return vectors;
  }

  private async computeEmbeddingScores(
    orgId: string,
    inputs: PreparedArchiveInput[],
    embeddingModel: string,
    anchorVectors: Map<ArchiveVertical, number[]>,
    runtime: ArchiveClassificationRuntimeOptions,
  ): Promise<Map<string, ArchiveVerticalScores>> {
    const normalizedAnchors = new Map<ArchiveVertical, number[]>();
    for (const vertical of ARCHIVE_VERTICAL_ORDER) {
      const vector = anchorVectors.get(vertical);
      if (!vector || vector.length === 0) {
        throw this.buildException(
          'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
          'Archive anchor embedding is missing for one or more verticals.',
          {
            orgId,
            layer: 'embedding',
            embeddingModel,
            vertical,
            processedArticleIds: inputs.map((input) => input.processedArticleId),
          },
        );
      }
      const normalizedVector = this.normalizeVector(vector);
      if (normalizedVector.length === 0) {
        throw this.buildException(
          'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
          'Archive anchor embedding vector is invalid.',
          {
            orgId,
            layer: 'embedding',
            embeddingModel,
            vertical,
            processedArticleIds: inputs.map((input) => input.processedArticleId),
          },
        );
      }
      normalizedAnchors.set(vertical, normalizedVector);
    }

    const chunks: PreparedArchiveInput[][] = [];
    for (
      let start = 0;
      start < inputs.length;
      start += runtime.embeddingBatchSize
    ) {
      chunks.push(inputs.slice(start, start + runtime.embeddingBatchSize));
    }

    const scoresById = new Map<string, ArchiveVerticalScores>();
    const chunkScores = await this.mapWithConcurrency(
      chunks,
      runtime.embeddingMaxConcurrency,
      async (chunk) => {
        let response;
        try {
          response = await this.liteLlm.embedding({
            orgId,
            model: embeddingModel,
            input: chunk.map((input) => input.classificationText),
            metadata: {
              source: ARCHIVE_CLASSIFICATION_SOURCE,
              layer: 'embedding',
              orgId,
              taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
              processedArticleIds: chunk.map((input) => input.processedArticleId),
            },
          });
        } catch (error) {
          throw this.buildLayerFailureException(
            'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
            'embedding',
            error,
            {
              orgId,
              embeddingModel,
              processedArticleIds: chunk.map((input) => input.processedArticleId),
            },
          );
        }

        const vectorsByIndex = new Map<number, number[]>();
        for (const row of response.data ?? []) {
          if (
            !row ||
            typeof row.index !== 'number' ||
            !Array.isArray(row.embedding) ||
            row.embedding.length === 0
          ) {
            continue;
          }
          vectorsByIndex.set(row.index, row.embedding);
        }

        const result = new Map<string, ArchiveVerticalScores>();
        for (let index = 0; index < chunk.length; index += 1) {
          const input = chunk[index];
          if (!input) {
            continue;
          }
          const vector = vectorsByIndex.get(index);
          if (!vector || vector.length === 0) {
            throw this.buildException(
              'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
              'Archive article embedding response is missing a usable vector.',
              {
                orgId,
                processedArticleId: input.processedArticleId,
                articleId: input.articleId,
                layer: 'embedding',
                embeddingModel,
              },
            );
          }
          const normalizedQuery = this.normalizeVector(vector);
          if (normalizedQuery.length === 0) {
            throw this.buildException(
              'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
              'Archive article embedding vector is invalid.',
              {
                orgId,
                processedArticleId: input.processedArticleId,
                articleId: input.articleId,
                layer: 'embedding',
                embeddingModel,
              },
            );
          }

          const scores = createArchiveVerticalScoreMap();
          for (const vertical of ARCHIVE_VERTICAL_ORDER) {
            const normalizedAnchor = normalizedAnchors.get(vertical);
            if (!normalizedAnchor || normalizedAnchor.length !== normalizedQuery.length) {
              throw this.buildException(
                'ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED',
                'Archive embedding vectors use inconsistent dimensions.',
                {
                  orgId,
                  processedArticleId: input.processedArticleId,
                  articleId: input.articleId,
                  layer: 'embedding',
                  embeddingModel,
                  vertical,
                },
              );
            }

            const cosine = this.dot(normalizedQuery, normalizedAnchor);
            scores[vertical] = this.clamp01((cosine + 1) / 2);
          }
          result.set(input.processedArticleId, scores);
        }

        return result;
      },
    );

    for (const batch of chunkScores) {
      batch.forEach((scores, processedArticleId) => {
        scoresById.set(processedArticleId, scores);
      });
    }

    return scoresById;
  }

  private async computeRerankScores(
    orgId: string,
    inputs: PreparedArchiveInput[],
    rerankModel: string,
    runtime: ArchiveClassificationRuntimeOptions,
  ): Promise<Map<string, ArchiveVerticalScores>> {
    const scoresById = new Map<string, ArchiveVerticalScores>();
    const documents = ARCHIVE_VERTICAL_ORDER.map(
      (vertical) => ARCHIVE_VERTICAL_ANCHORS[vertical],
    );

    const results = await this.mapWithConcurrency(
      inputs,
      runtime.rerankMaxConcurrency,
      async (input) => {
        let response;
        try {
          response = await this.liteLlm.rerank({
            orgId,
            model: rerankModel,
            query: input.classificationText,
            documents,
            topN: documents.length,
            metadata: {
              source: ARCHIVE_CLASSIFICATION_SOURCE,
              layer: 'rerank',
              orgId,
              processedArticleId: input.processedArticleId,
              articleId: input.articleId,
              taxonomyVersion: ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION,
            },
          });
        } catch (error) {
          throw this.buildLayerFailureException(
            'ARCHIVE_CLASSIFICATION_RERANK_FAILED',
            'rerank',
            error,
            {
              orgId,
              processedArticleId: input.processedArticleId,
              articleId: input.articleId,
              rerankModel,
            },
          );
        }

        const rawResults = (response.results ?? [])
          .map((entry) => {
            const index = typeof entry.index === 'number' ? entry.index : -1;
            const score = typeof entry.score === 'number' ? entry.score : null;
            if (index < 0 || index >= ARCHIVE_VERTICAL_ORDER.length || score === null) {
              return null;
            }
            return {
              vertical: ARCHIVE_VERTICAL_ORDER[index]!,
              score,
            };
          })
          .filter(
            (
              entry,
            ): entry is { vertical: ArchiveVertical; score: number } =>
              Boolean(entry),
          );

        if (rawResults.length === 0) {
          throw this.buildException(
            'ARCHIVE_CLASSIFICATION_RERANK_FAILED',
            'Archive rerank returned no usable results.',
            {
              orgId,
              processedArticleId: input.processedArticleId,
              articleId: input.articleId,
              layer: 'rerank',
              rerankModel,
            },
          );
        }

        const minScore = Math.min(...rawResults.map((entry) => entry.score));
        const maxScore = Math.max(...rawResults.map((entry) => entry.score));
        const normalized = createArchiveVerticalScoreMap();

        for (const entry of rawResults) {
          normalized[entry.vertical] =
            maxScore === minScore
              ? 1
              : this.clamp01((entry.score - minScore) / (maxScore - minScore));
        }

        return {
          processedArticleId: input.processedArticleId,
          scores: normalized,
        };
      },
    );

    for (const result of results) {
      scoresById.set(result.processedArticleId, result.scores);
    }

    return scoresById;
  }

  private combineScores(
    ruleScores: ArchiveVerticalScores,
    embeddingScores: ArchiveVerticalScores,
    rerankScores: ArchiveVerticalScores,
  ): ArchiveVerticalScores {
    const fusedScores = createArchiveVerticalScoreMap();

    for (const vertical of ARCHIVE_VERTICAL_ORDER) {
      let total = 0;
      let totalWeight = 0;

      const ruleScore = ruleScores[vertical];
      if (typeof ruleScore === 'number') {
        total += ruleScore * ARCHIVE_FUSION_WEIGHTS.rule;
        totalWeight += ARCHIVE_FUSION_WEIGHTS.rule;
      }

      const embeddingScore = embeddingScores[vertical];
      if (typeof embeddingScore === 'number') {
        total += embeddingScore * ARCHIVE_FUSION_WEIGHTS.embedding;
        totalWeight += ARCHIVE_FUSION_WEIGHTS.embedding;
      }

      const rerankScore = rerankScores[vertical];
      if (typeof rerankScore === 'number') {
        total += rerankScore * ARCHIVE_FUSION_WEIGHTS.rerank;
        totalWeight += ARCHIVE_FUSION_WEIGHTS.rerank;
      }

      fusedScores[vertical] =
        totalWeight > 0 ? this.clamp01(total / totalWeight) : 0;
    }

    return fusedScores;
  }

  private selectVertical(
    fusedScores: ArchiveVerticalScores,
    ruleScores: ArchiveVerticalScores,
    rerankScores: ArchiveVerticalScores,
  ): ArchiveVertical {
    return ARCHIVE_VERTICAL_ORDER.slice().sort((left, right) => {
      const fusedDelta = (fusedScores[right] ?? 0) - (fusedScores[left] ?? 0);
      if (Math.abs(fusedDelta) > SCORE_TIE_EPSILON) {
        return fusedDelta > 0 ? 1 : -1;
      }

      const ruleDelta = (ruleScores[right] ?? 0) - (ruleScores[left] ?? 0);
      if (Math.abs(ruleDelta) > SCORE_TIE_EPSILON) {
        return ruleDelta > 0 ? 1 : -1;
      }

      const rerankDelta = (rerankScores[right] ?? 0) - (rerankScores[left] ?? 0);
      if (Math.abs(rerankDelta) > SCORE_TIE_EPSILON) {
        return rerankDelta > 0 ? 1 : -1;
      }

      return (
        (VERTICAL_ORDER_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (VERTICAL_ORDER_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER)
      );
    })[0]!;
  }

  private async persistResults(
    orgId: string,
    results: ArchiveHybridClassificationResult[],
  ): Promise<void> {
    if (results.length === 0) {
      return;
    }

    const writes = results.map((result) =>
      this.prisma.archiveArticleClassification.upsert({
        where: { processedArticleId: result.processedArticleId },
        create: {
          orgId,
          articleId: result.articleId,
          processedArticleId: result.processedArticleId,
          region: result.region,
          vertical: result.vertical,
          ruleScores: toPrismaJsonValue(result.ruleScores),
          embeddingScores: toPrismaJsonValue(result.embeddingScores),
          rerankScores: toPrismaJsonValue(result.rerankScores),
          fusedScores: toPrismaJsonValue(result.fusedScores),
          classificationTextHash: result.classificationTextHash,
          classificationTextVersion: result.classificationTextVersion,
          taxonomyVersion: result.taxonomyVersion,
          pipelineVersion: result.pipelineVersion,
          embeddingModel: result.embeddingModel,
          rerankModel: result.rerankModel,
        },
        update: {
          articleId: result.articleId,
          region: result.region,
          vertical: result.vertical,
          ruleScores: toPrismaJsonValue(result.ruleScores),
          embeddingScores: toPrismaJsonValue(result.embeddingScores),
          rerankScores: toPrismaJsonValue(result.rerankScores),
          fusedScores: toPrismaJsonValue(result.fusedScores),
          classificationTextHash: result.classificationTextHash,
          classificationTextVersion: result.classificationTextVersion,
          taxonomyVersion: result.taxonomyVersion,
          pipelineVersion: result.pipelineVersion,
          embeddingModel: result.embeddingModel,
          rerankModel: result.rerankModel,
        },
      }),
    );

    await this.runPrismaWritesInBatches(
      writes,
      ARCHIVE_CLASSIFICATION_PERSIST_BATCH_SIZE,
      (error) =>
        this.buildLayerFailureException(
          'ARCHIVE_CLASSIFICATION_PERSIST_FAILED',
          'persist',
          error,
          {
            orgId,
            processedArticleIds: results.map((result) => result.processedArticleId),
          },
        ),
    );
  }

  private async runPrismaWritesInBatches<T>(
    writes: Prisma.PrismaPromise<T>[],
    batchSize: number,
    createError: (error: unknown) => ServiceUnavailableException,
  ): Promise<void> {
    for (let start = 0; start < writes.length; start += batchSize) {
      try {
        await this.prisma.$transaction(writes.slice(start, start + batchSize));
      } catch (error) {
        throw createError(error);
      }
    }
  }

  private buildClassificationText(input: ArchiveClassifierInput): string {
    const title = this.normalizeOptionalString(input.title);
    const summary = this.normalizeOptionalString(input.summary);
    const topics = this.normalizeStringArray(input.topics);
    const entities = this.normalizeEntityNames(input.entities);
    const location = this.normalizeOptionalString(input.location);

    const lines = [
      title ? `Title: ${title}` : null,
      summary ? `Summary: ${summary}` : null,
      topics.length > 0 ? `Topics: ${topics.join(' | ')}` : null,
      entities.length > 0 ? `Entities: ${entities.join(' | ')}` : null,
      location ? `Location: ${location}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    return lines.length > 0 ? lines.join('\n') : ARCHIVE_CLASSIFICATION_EMPTY_TEXT;
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((entry) => this.normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
  }

  private normalizeEntityNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const names: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const normalized = this.normalizeOptionalString(entry);
        if (normalized) {
          names.push(normalized);
        }
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const name = this.normalizeOptionalString(
        (entry as { name?: unknown }).name,
      );
      if (name) {
        names.push(name);
      }
    }

    return Array.from(new Set(names));
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private parseScoreMap(value: unknown): ArchiveVerticalScores {
    const base = createArchiveVerticalScoreMap();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return base;
    }

    const record = value as Record<string, unknown>;
    for (const vertical of ARCHIVE_VERTICAL_ORDER) {
      const score = record[vertical];
      if (typeof score === 'number' && Number.isFinite(score)) {
        base[vertical] = this.clamp01(score);
      }
    }

    return base;
  }

  private parseVector(value: unknown): number[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
    );
  }

  private parseRegion(value: string): ArchiveRegion | null {
    return Object.values(ArchiveRegion).includes(value as ArchiveRegion)
      ? (value as ArchiveRegion)
      : null;
  }

  private parseVertical(value: string): ArchiveVertical | null {
    return Object.values(ArchiveVertical).includes(value as ArchiveVertical)
      ? (value as ArchiveVertical)
      : null;
  }

  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(
      vector.reduce((sum, entry) => sum + entry * entry, 0),
    );
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      return [];
    }

    return vector.map((entry) => entry / magnitude);
  }

  private dot(left: number[], right: number[]): number {
    let total = 0;
    for (let index = 0; index < left.length; index += 1) {
      total += left[index]! * right[index]!;
    }
    return total;
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value <= 0) {
      return 0;
    }
    if (value >= 1) {
      return 1;
    }
    return value;
  }

  private resolveRuntimeOptions(
    options?: Partial<ArchiveClassificationRuntimeOptions>,
  ): ArchiveClassificationRuntimeOptions {
    return {
      jobBatchSize: this.toPositiveInt(
        options?.jobBatchSize,
        ARCHIVE_CLASSIFICATION_EMBEDDING_BATCH_SIZE,
      ),
      embeddingBatchSize: this.toPositiveInt(
        options?.embeddingBatchSize,
        ARCHIVE_CLASSIFICATION_EMBEDDING_BATCH_SIZE,
      ),
      embeddingMaxConcurrency: this.toPositiveInt(options?.embeddingMaxConcurrency, 1),
      rerankMaxConcurrency: this.toPositiveInt(
        options?.rerankMaxConcurrency,
        ARCHIVE_CLASSIFICATION_RERANK_CONCURRENCY,
      ),
    };
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.max(1, Math.round(parsed));
  }

  private async mapWithConcurrency<TInput, TResult>(
    items: TInput[],
    concurrency: number,
    mapper: (item: TInput) => Promise<TResult>,
  ): Promise<TResult[]> {
    if (items.length === 0) {
      return [];
    }
    const results = new Array<TResult>(items.length);
    const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    const workers = Array.from({ length: safeConcurrency }, async () => {
      for (;;) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await mapper(items[currentIndex]!);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private hashText(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private buildLayerFailureException(
    code: string,
    layer: 'embedding' | 'rerank' | 'persist',
    error: unknown,
    context: Record<string, unknown>,
  ): ServiceUnavailableException {
    this.logger.error(
      {
        err: error,
        ...context,
        layer,
      },
      'Archive hybrid classification layer failed.',
    );

    const message =
      error instanceof Error && error.message
        ? error.message
        : `Archive classification ${layer} layer failed.`;

    return this.buildException(code, message, {
      ...context,
      layer,
    });
  }

  private buildException(
    code: string,
    message: string,
    context: Record<string, unknown>,
  ): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code,
      message,
      ...context,
    });
  }
}
