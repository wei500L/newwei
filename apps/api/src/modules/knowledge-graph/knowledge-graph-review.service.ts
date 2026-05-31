import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { KnowledgeGraphService } from "./knowledge-graph.service";

export type KnowledgeGraphEvidenceReviewStatus = "approved" | "rejected" | "corrected";

const logger = createLogger({ name: "knowledge-graph-review" });
const RECONCILE_BATCH_SIZE = 200;

@Injectable()
export class KnowledgeGraphReviewService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly graph: KnowledgeGraphService
  ) {}

  async listEvidenceReviewQueue(input: {
    orgId: string;
    limit: number;
    maxEvidenceConfidence?: number;
    onlyUnreviewed: boolean;
  }) {
    const limit = Math.min(Math.max(input.limit, 1), 200);
    const take = Math.min(500, Math.max(50, limit * 4));

    const rows = await this.prisma.knowledgeEdgeEvidence.findMany({
      where: {
        orgId: input.orgId,
        ...(typeof input.maxEvidenceConfidence === "number"
          ? { confidence: { lte: input.maxEvidenceConfidence } }
          : {})
      },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        edge: {
          include: {
            fromEntity: true,
            toEntity: true
          }
        },
        article: {
          include: {
            processed: true
          }
        }
      }
    });

    const items: typeof rows = [];

    for (const row of rows) {
      const evidence = this.asRecord(row.evidence);
      const review = this.asRecord(evidence?.review);
      const status = this.readReviewStatus(review);

      if (input.onlyUnreviewed && status) {
        continue;
      }

      items.push(row);
      if (items.length >= limit) {
        break;
      }
    }

    return items;
  }

  async reviewEvidence(input: {
    orgId: string;
    actorId: string;
    evidenceId: string;
    status: KnowledgeGraphEvidenceReviewStatus;
    note?: string | null;
    correctedRelation?: unknown | null;
  }) {
    const review = {
      status: input.status,
      note: input.note ?? null,
      correctedRelation: input.correctedRelation ?? null,
      reviewerId: input.actorId,
      reviewedAt: new Date().toISOString()
    };

    const result = await this.applyReviewToEvidence({
      orgId: input.orgId,
      evidenceId: input.evidenceId,
      status: input.status,
      correctedRelation: input.correctedRelation ?? null,
      review
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: input.orgId,
          actorId: input.actorId,
          resource: "knowledge_graph",
          action: "knowledge_graph_evidence_review",
          metadata: toPrismaJsonValue({
            evidenceId: input.evidenceId,
            status: input.status,
            edgeIds: result.edgeIds,
            returnedEvidenceId: result.evidenceId,
            deletedEdgeIds: result.deletedEdgeIds
          })
        }
      },
      { orgId: input.orgId, evidenceId: input.evidenceId, status: input.status }
    );

    await this.invalidateGraphCachesBestEffort(input.orgId);

    if (!result.evidenceId) {
      return null;
    }

    return this.prisma.knowledgeEdgeEvidence.findFirst({
      where: { id: result.evidenceId, orgId: input.orgId },
      include: {
        edge: {
          include: {
            fromEntity: true,
            toEntity: true
          }
        },
        article: {
          include: {
            processed: true
          }
        }
      }
    });
  }

  async reconcileReviewedEvidence(input?: { orgId?: string; batchSize?: number; maxRows?: number }) {
    const batchSize = Math.min(Math.max(input?.batchSize ?? RECONCILE_BATCH_SIZE, 1), 500);
    const maxRows = typeof input?.maxRows === "number" && input.maxRows > 0 ? Math.floor(input.maxRows) : undefined;
    let cursor: string | undefined;
    let scanned = 0;
    let reconciled = 0;
    let skipped = 0;
    let failed = 0;
    const orgIds = new Set<string>();

    while (maxRows === undefined || scanned < maxRows) {
      const take = maxRows === undefined ? batchSize : Math.min(batchSize, maxRows - scanned);
      if (take <= 0) {
        break;
      }

      const rows = await this.prisma.knowledgeEdgeEvidence.findMany({
        where: {
          ...(input?.orgId ? { orgId: input.orgId } : {}),
          ...(cursor ? { id: { gt: cursor } } : {})
        },
        orderBy: { id: "asc" },
        take,
        select: {
          id: true,
          orgId: true,
          evidence: true
        }
      });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        scanned += 1;
        cursor = row.id;
        const evidence = this.asRecord(row.evidence);
        const review = this.asRecord(evidence?.review);
        const status = this.readReviewStatus(review);
        if (!status || !review) {
          skipped += 1;
          continue;
        }

        try {
          await this.applyReviewToEvidence({
            orgId: row.orgId,
            evidenceId: row.id,
            status,
            correctedRelation: review?.correctedRelation ?? null,
            review
          });
          reconciled += 1;
          orgIds.add(row.orgId);
        } catch (error) {
          failed += 1;
          logger.warn(
            { err: error, orgId: row.orgId, evidenceId: row.id, status },
            "Failed to reconcile reviewed knowledge graph evidence"
          );
        }
      }
    }

    for (const orgId of orgIds) {
      await this.invalidateGraphCachesBestEffort(orgId);
    }

    return { scanned, reconciled, skipped, failed };
  }

  private async applyReviewToEvidence(input: {
    orgId: string;
    evidenceId: string;
    status: KnowledgeGraphEvidenceReviewStatus;
    correctedRelation: unknown | null;
    review: Record<string, unknown>;
  }): Promise<{ evidenceId: string | null; edgeIds: string[]; deletedEdgeIds: string[] }> {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.knowledgeEdgeEvidence.findFirst({
        where: { id: input.evidenceId, orgId: input.orgId },
        select: {
          id: true,
          orgId: true,
          edgeId: true,
          articleId: true,
          confidence: true,
          evidence: true
        }
      });
      if (!existing) {
        throw new NotFoundException("Knowledge graph evidence not found");
      }

      const previous = this.asRecord(existing.evidence) ?? {};
      const review = { ...input.review, status: input.status };
      const nextEvidence = { ...previous, review };
      const touchedEdgeIds = new Set<string>([existing.edgeId]);
      const deletedEdgeIds: string[] = [];
      let returnedEvidenceId: string | null = existing.id;

      if (input.status === "corrected") {
        const relation = this.graph.normalizeReviewedRelation(input.correctedRelation);
        if (!relation) {
          throw new BadRequestException("Invalid corrected knowledge graph relation");
        }

        const targetEdge = await this.graph.upsertReviewedRelationEdge(tx, {
          orgId: input.orgId,
          relation,
          confidence: existing.confidence ?? 0.5,
          now: new Date()
        });
        touchedEdgeIds.add(targetEdge.id);

        if (targetEdge.id === existing.edgeId) {
          await tx.knowledgeEdgeEvidence.update({
            where: { id: existing.id },
            data: {
              evidence: toPrismaJsonValue(nextEvidence)
            }
          });
        } else {
          const duplicate = await tx.knowledgeEdgeEvidence.findUnique({
            where: {
              edgeId_articleId: {
                edgeId: targetEdge.id,
                articleId: existing.articleId
              }
            },
            select: {
              id: true,
              confidence: true,
              evidence: true
            }
          });

          if (duplicate) {
            const duplicateEvidence = this.asRecord(duplicate.evidence) ?? {};
            await tx.knowledgeEdgeEvidence.update({
              where: { id: duplicate.id },
              data: {
                confidence: duplicate.confidence ?? existing.confidence,
                evidence: toPrismaJsonValue({
                  ...nextEvidence,
                  ...duplicateEvidence,
                  review
                })
              }
            });
            await tx.knowledgeEdgeEvidence.delete({ where: { id: existing.id } });
            returnedEvidenceId = duplicate.id;
          } else {
            await tx.knowledgeEdgeEvidence.update({
              where: { id: existing.id },
              data: {
                edgeId: targetEdge.id,
                evidence: toPrismaJsonValue(nextEvidence)
              }
            });
          }
        }
      } else {
        await tx.knowledgeEdgeEvidence.update({
          where: { id: existing.id },
          data: {
            evidence: toPrismaJsonValue(nextEvidence)
          }
        });
      }

      for (const edgeId of touchedEdgeIds) {
        const result = await this.recomputeEdgeAggregate(tx, input.orgId, edgeId);
        if (result.deleted) {
          deletedEdgeIds.push(edgeId);
          if (edgeId === existing.edgeId && input.status !== "corrected") {
            returnedEvidenceId = null;
          }
        }
      }

      return {
        evidenceId: returnedEvidenceId,
        edgeIds: Array.from(touchedEdgeIds),
        deletedEdgeIds
      };
    });
  }

  private async recomputeEdgeAggregate(
    tx: Prisma.TransactionClient,
    orgId: string,
    edgeId: string
  ): Promise<{ deleted: boolean }> {
    const edge = await tx.knowledgeEdge.findFirst({
      where: { id: edgeId, orgId },
      select: {
        id: true,
        properties: true
      }
    });
    if (!edge) {
      return { deleted: false };
    }

    const rows = await tx.knowledgeEdgeEvidence.findMany({
      where: { orgId, edgeId },
      select: {
        id: true,
        confidence: true,
        evidence: true,
        createdAt: true
      },
      orderBy: { createdAt: "asc" }
    });

    const activeRows = rows.filter((row) => {
      const evidence = this.asRecord(row.evidence);
      const review = this.asRecord(evidence?.review);
      return this.readReviewStatus(review) !== "rejected";
    });

    if (activeRows.length === 0) {
      if (this.hasDurableRecordSource(edge.properties)) {
        return { deleted: false };
      }

      await tx.knowledgeEdgeEvidence.deleteMany({
        where: { orgId, edgeId }
      });
      await tx.knowledgeEdge.delete({
        where: { id: edgeId }
      });
      return { deleted: true };
    }

    const confidence =
      activeRows.reduce((sum, row) => {
        const value = typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0.5;
        return sum + Math.min(1, Math.max(0, value));
      }, 0) / activeRows.length;
    const firstSeenAt = activeRows[0]?.createdAt ?? new Date();
    const lastSeenAt = activeRows[activeRows.length - 1]?.createdAt ?? firstSeenAt;

    await tx.knowledgeEdge.update({
      where: { id: edgeId },
      data: {
        weight: activeRows.length,
        confidence,
        firstSeenAt,
        lastSeenAt
      }
    });

    return { deleted: false };
  }

  private async invalidateGraphCachesBestEffort(orgId: string) {
    try {
      await Promise.all([
        this.cache.delByPrefix(`knowledgeGraph:subgraph:${orgId}:`),
        this.cache.delByPrefix(`knowledgeGraph:impact:${orgId}:`)
      ]);
    } catch (error) {
      logger.warn({ err: error, orgId }, "Failed to invalidate knowledge graph caches after review");
    }
  }

  private readReviewStatus(review: Record<string, unknown> | null | undefined): KnowledgeGraphEvidenceReviewStatus | null {
    const status = typeof review?.status === "string" ? review.status.trim() : "";
    if (status === "approved" || status === "rejected" || status === "corrected") {
      return status;
    }
    return null;
  }

  private hasDurableRecordSource(value: Prisma.JsonValue | null) {
    const record = this.asRecord(value);
    const source = typeof record?.recordSource === "string" ? record.recordSource : null;
    return source === "seed" || source === "user" || source === "derived";
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }
}
