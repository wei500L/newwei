import { Injectable, NotFoundException } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

export type KnowledgeGraphEvidenceReviewStatus = "approved" | "rejected" | "corrected";

@Injectable()
export class KnowledgeGraphReviewService {
  constructor(private readonly prisma: PrismaService) {}

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
      const evidence =
        row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
          ? (row.evidence as Record<string, unknown>)
          : null;
      const review =
        evidence && typeof evidence.review === "object" && evidence.review && !Array.isArray(evidence.review)
          ? (evidence.review as Record<string, unknown>)
          : null;
      const status = typeof review?.status === "string" ? review.status.trim() : "";

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
    const existing = await this.prisma.knowledgeEdgeEvidence.findFirst({
      where: { id: input.evidenceId, orgId: input.orgId }
    });
    if (!existing) {
      throw new NotFoundException("Knowledge graph evidence not found");
    }

    const previous =
      existing.evidence && typeof existing.evidence === "object" && !Array.isArray(existing.evidence)
        ? (existing.evidence as Record<string, unknown>)
        : {};

    const review = {
      status: input.status,
      note: input.note ?? null,
      correctedRelation: input.correctedRelation ?? null,
      reviewerId: input.actorId,
      reviewedAt: new Date().toISOString()
    };

    const nextEvidence = { ...previous, review };

    await this.prisma.knowledgeEdgeEvidence.update({
      where: { id: input.evidenceId },
      data: {
        evidence: toPrismaJsonValue(nextEvidence)
      }
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
            status: input.status
          })
        }
      },
      { orgId: input.orgId, evidenceId: input.evidenceId, status: input.status }
    );

    return this.prisma.knowledgeEdgeEvidence.findFirst({
      where: { id: input.evidenceId, orgId: input.orgId },
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
}
