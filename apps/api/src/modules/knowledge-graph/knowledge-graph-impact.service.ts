import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { KnowledgeEntityType, KnowledgeRelationType, type KnowledgeEdge, type KnowledgeEntity, type Prisma } from "@prisma/client";

import { AkshareGatewayClient } from "../akshare/akshare-gateway.client";
import { PrismaService } from "../config/prisma.service";

import { KnowledgeGraphService } from "./knowledge-graph.service";

const logger = createLogger({ name: "knowledge-graph-impact" });

export type ImpactScenario = "executive_change" | "commodity_move" | "policy_event";

export interface ExplainChain {
  reason: string;
  nodes: KnowledgeEntity[];
  edges: KnowledgeEdge[];
}

export interface ImpactCandidate {
  entity: KnowledgeEntity;
  score: number;
  kind: string;
  chains: ExplainChain[];
}

export interface ImpactAnalysisResult {
  scenario: ImpactScenario;
  seed: KnowledgeEntity;
  candidates: ImpactCandidate[];
  metadata: Record<string, unknown>;
}

export interface ExecutiveChangeImpactInput {
  orgId: string;
  companyName: string;
  maxCandidates: number;
}

export interface CommodityMoveImpactInput {
  orgId: string;
  commodityName: string;
  maxCandidates: number;
}

export interface PolicyEventImpactInput {
  orgId: string;
  policyName: string;
  maxCandidates: number;
  includeLprSnapshot?: boolean;
}

@Injectable()
export class KnowledgeGraphImpactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: KnowledgeGraphService,
    private readonly akshare: AkshareGatewayClient
  ) {}

  async analyzeExecutiveChange(input: ExecutiveChangeImpactInput): Promise<ImpactAnalysisResult | null> {
    const maxCandidates = Math.min(200, Math.max(1, input.maxCandidates));
    const seed = await this.resolveCompanySeed(input.orgId, input.companyName);
    if (!seed) {
      return null;
    }

    const candidates = new Map<string, ImpactCandidate>();

    const tickers = await this.findRelatedEntities({
      orgId: input.orgId,
      seedId: seed.id,
      relationTypes: [KnowledgeRelationType.has_ticker],
      limit: 50
    });

    for (const edge of tickers.edges) {
      const instrumentId = edge.fromEntityId === seed.id ? edge.toEntityId : edge.fromEntityId;
      const instrument = tickers.nodesById.get(instrumentId);
      if (!instrument || instrument.type !== KnowledgeEntityType.instrument) {
        continue;
      }

      this.upsertCandidate(candidates, instrument, {
        score: 100 + edge.weight * 2 + edge.confidence * 10,
        kind: "ticker",
        chain: {
          reason: "company_has_ticker",
          nodes: [seed, instrument],
          edges: [edge]
        }
      });
    }

    const industries = await this.findRelatedEntities({
      orgId: input.orgId,
      seedId: seed.id,
      relationTypes: [KnowledgeRelationType.belongs_to_industry],
      limit: 50
    });

    const industryIds = Array.from(industries.nodesById.values())
      .filter((node) => node.type === KnowledgeEntityType.industry)
      .map((node) => node.id);

    const directCompetitors = await this.findRelatedEntities({
      orgId: input.orgId,
      seedId: seed.id,
      relationTypes: [KnowledgeRelationType.competes_with],
      limit: 50
    });

    for (const edge of directCompetitors.edges) {
      const competitorId = edge.fromEntityId === seed.id ? edge.toEntityId : edge.fromEntityId;
      const competitor = directCompetitors.nodesById.get(competitorId);
      if (!competitor || competitor.type !== KnowledgeEntityType.company || competitor.id === seed.id) {
        continue;
      }
      this.upsertCandidate(candidates, competitor, {
        score: 80 + edge.weight * 2 + edge.confidence * 10,
        kind: "competitor",
        chain: {
          reason: "competes_with",
          nodes: [seed, competitor],
          edges: [edge]
        }
      });
    }

    if (industryIds.length > 0) {
      const membership = await this.prisma.knowledgeEdge.findMany({
        where: {
          orgId: input.orgId,
          type: KnowledgeRelationType.belongs_to_industry,
          OR: [{ fromEntityId: { in: industryIds } }, { toEntityId: { in: industryIds } }]
        },
        orderBy: [{ weight: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
        take: Math.max(200, maxCandidates * 10)
      });

      const companyIds = new Set<string>();
      for (const edge of membership) {
        const otherId = industryIds.includes(edge.fromEntityId) ? edge.toEntityId : edge.fromEntityId;
        if (otherId !== seed.id) {
          companyIds.add(otherId);
        }
      }

      const companies = await this.prisma.knowledgeEntity.findMany({
        where: { id: { in: Array.from(companyIds) } }
      });

      const companiesById = new Map(companies.map((company) => [company.id, company]));
      const industriesById = industries.nodesById;

      for (const edge of membership) {
        const industryId = industryIds.includes(edge.fromEntityId) ? edge.fromEntityId : edge.toEntityId;
        const companyId = industryId === edge.fromEntityId ? edge.toEntityId : edge.fromEntityId;
        const company = companiesById.get(companyId);
        const industry = industriesById.get(industryId);
        if (!company || company.type !== KnowledgeEntityType.company || company.id === seed.id) {
          continue;
        }
        if (!industry || industry.type !== KnowledgeEntityType.industry) {
          continue;
        }

        const seedIndustryEdge = industries.edges.find((e) =>
          this.edgeTouchesEntityPair(e, seed.id, industry.id)
        );
        if (!seedIndustryEdge) {
          continue;
        }

        this.upsertCandidate(candidates, company, {
          score: 60 + edge.weight + edge.confidence * 5,
          kind: "peer",
          chain: {
            reason: "same_industry",
            nodes: [seed, industry, company],
            edges: [seedIndustryEdge, edge]
          }
        });
      }
    }

    const sorted = this.sortCandidates(Array.from(candidates.values())).slice(0, maxCandidates);
    return {
      scenario: "executive_change",
      seed,
      candidates: sorted,
      metadata: {
        totalCandidates: sorted.length
      }
    };
  }

  async analyzeCommodityMove(input: CommodityMoveImpactInput): Promise<ImpactAnalysisResult | null> {
    const maxCandidates = Math.min(200, Math.max(1, input.maxCandidates));
    const seed = await this.graph.resolveEntity(input.orgId, input.commodityName, KnowledgeEntityType.commodity);
    if (!seed) {
      return null;
    }

    const candidates = new Map<string, ImpactCandidate>();

    const impact = await this.findRelatedEntities({
      orgId: input.orgId,
      seedId: seed.id,
      relationTypes: [
        KnowledgeRelationType.affects_industry,
        KnowledgeRelationType.affects_company,
        KnowledgeRelationType.downstream_of,
        KnowledgeRelationType.upstream_of
      ],
      limit: 200
    });

    const industryIdsSet = new Set<string>();
    for (const edge of impact.edges) {
      const otherId = edge.fromEntityId === seed.id ? edge.toEntityId : edge.fromEntityId;
      const other = impact.nodesById.get(otherId);
      if (!other) {
        continue;
      }
      if (other.type === KnowledgeEntityType.industry) {
        industryIdsSet.add(other.id);
        this.upsertCandidate(candidates, other, {
          score: 80 + edge.confidence * 20 + edge.weight,
          kind: "industry",
          chain: {
            reason: edge.type,
            nodes: [seed, other],
            edges: [edge]
          }
        });
      } else if (other.type === KnowledgeEntityType.company && edge.type === KnowledgeRelationType.affects_company) {
        this.upsertCandidate(candidates, other, {
          score: 70 + edge.confidence * 20 + edge.weight,
          kind: "company",
          chain: {
            reason: edge.type,
            nodes: [seed, other],
            edges: [edge]
          }
        });
      }
    }

    const industryIds = Array.from(industryIdsSet);
    if (industryIds.length > 0) {
      const membership = await this.prisma.knowledgeEdge.findMany({
        where: {
          orgId: input.orgId,
          type: KnowledgeRelationType.belongs_to_industry,
          OR: [{ fromEntityId: { in: industryIds } }, { toEntityId: { in: industryIds } }]
        },
        orderBy: [{ weight: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
        take: Math.max(500, maxCandidates * 10)
      });

      const companyIds = new Set<string>();
      for (const edge of membership) {
        const otherId = industryIds.includes(edge.fromEntityId) ? edge.toEntityId : edge.fromEntityId;
        companyIds.add(otherId);
      }

      const companies = await this.prisma.knowledgeEntity.findMany({
        where: { id: { in: Array.from(companyIds) } }
      });
      const companiesById = new Map(companies.map((company) => [company.id, company]));

      for (const edge of membership) {
        const industryId = industryIds.includes(edge.fromEntityId) ? edge.fromEntityId : edge.toEntityId;
        const companyId = industryId === edge.fromEntityId ? edge.toEntityId : edge.fromEntityId;
        const company = companiesById.get(companyId);
        const industry = impact.nodesById.get(industryId);
        if (!company || company.type !== KnowledgeEntityType.company) {
          continue;
        }
        if (!industry || industry.type !== KnowledgeEntityType.industry) {
          continue;
        }

        const seedIndustryEdge = impact.edges.find((e) => this.edgeTouchesEntityPair(e, seed.id, industry.id));
        if (!seedIndustryEdge) {
          continue;
        }

        this.upsertCandidate(candidates, company, {
          score: 50 + seedIndustryEdge.confidence * 10 + edge.confidence * 5,
          kind: "company",
          chain: {
            reason: "commodity_to_industry_to_company",
            nodes: [seed, industry, company],
            edges: [seedIndustryEdge, edge]
          }
        });
      }
    }

    const sorted = this.sortCandidates(Array.from(candidates.values())).slice(0, maxCandidates);
    return {
      scenario: "commodity_move",
      seed,
      candidates: sorted,
      metadata: {
        totalCandidates: sorted.length,
        impactedIndustries: industryIds.length
      }
    };
  }

  async analyzePolicyEvent(input: PolicyEventImpactInput): Promise<ImpactAnalysisResult | null> {
    const maxCandidates = Math.min(200, Math.max(1, input.maxCandidates));
    const seed = await this.graph.resolveEntity(input.orgId, input.policyName, KnowledgeEntityType.policy);
    if (!seed) {
      return null;
    }

    const candidates = new Map<string, ImpactCandidate>();

    const impact = await this.findRelatedEntities({
      orgId: input.orgId,
      seedId: seed.id,
      relationTypes: [KnowledgeRelationType.affects_industry, KnowledgeRelationType.affects_company],
      limit: 200
    });

    const industryIdsSet = new Set<string>();
    for (const edge of impact.edges) {
      const otherId = edge.fromEntityId === seed.id ? edge.toEntityId : edge.fromEntityId;
      const other = impact.nodesById.get(otherId);
      if (!other) {
        continue;
      }
      if (other.type === KnowledgeEntityType.industry) {
        industryIdsSet.add(other.id);
        this.upsertCandidate(candidates, other, {
          score: 80 + edge.confidence * 20 + edge.weight,
          kind: "industry",
          chain: {
            reason: edge.type,
            nodes: [seed, other],
            edges: [edge]
          }
        });
      } else if (other.type === KnowledgeEntityType.company && edge.type === KnowledgeRelationType.affects_company) {
        this.upsertCandidate(candidates, other, {
          score: 70 + edge.confidence * 20 + edge.weight,
          kind: "company",
          chain: {
            reason: edge.type,
            nodes: [seed, other],
            edges: [edge]
          }
        });
      }
    }

    const industryIds = Array.from(industryIdsSet);
    if (industryIds.length > 0) {
      const membership = await this.prisma.knowledgeEdge.findMany({
        where: {
          orgId: input.orgId,
          type: KnowledgeRelationType.belongs_to_industry,
          OR: [{ fromEntityId: { in: industryIds } }, { toEntityId: { in: industryIds } }]
        },
        orderBy: [{ weight: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
        take: Math.max(500, maxCandidates * 10)
      });

      const companyIds = new Set<string>();
      for (const edge of membership) {
        const otherId = industryIds.includes(edge.fromEntityId) ? edge.toEntityId : edge.fromEntityId;
        companyIds.add(otherId);
      }

      const companies = await this.prisma.knowledgeEntity.findMany({
        where: { id: { in: Array.from(companyIds) } }
      });
      const companiesById = new Map(companies.map((company) => [company.id, company]));

      for (const edge of membership) {
        const industryId = industryIds.includes(edge.fromEntityId) ? edge.fromEntityId : edge.toEntityId;
        const companyId = industryId === edge.fromEntityId ? edge.toEntityId : edge.fromEntityId;
        const company = companiesById.get(companyId);
        const industry = impact.nodesById.get(industryId);
        if (!company || company.type !== KnowledgeEntityType.company) {
          continue;
        }
        if (!industry || industry.type !== KnowledgeEntityType.industry) {
          continue;
        }

        const seedIndustryEdge = impact.edges.find((e) => this.edgeTouchesEntityPair(e, seed.id, industry.id));
        if (!seedIndustryEdge) {
          continue;
        }

        this.upsertCandidate(candidates, company, {
          score: 50 + seedIndustryEdge.confidence * 10 + edge.confidence * 5,
          kind: "company",
          chain: {
            reason: "policy_to_industry_to_company",
            nodes: [seed, industry, company],
            edges: [seedIndustryEdge, edge]
          }
        });
      }
    }

    const metadata: Record<string, unknown> = {
      totalCandidates: candidates.size,
      impactedIndustries: industryIds.length
    };

    if (input.includeLprSnapshot) {
      try {
        metadata.lpr = await this.fetchLatestLprSnapshot();
      } catch (error) {
        logger.warn({ err: error }, "Failed to fetch LPR snapshot from akshare");
      }
    }

    const sorted = this.sortCandidates(Array.from(candidates.values())).slice(0, maxCandidates);
    return {
      scenario: "policy_event",
      seed,
      candidates: sorted,
      metadata
    };
  }

  private upsertCandidate(
    map: Map<string, ImpactCandidate>,
    entity: KnowledgeEntity,
    input: { score: number; kind: string; chain: ExplainChain }
  ) {
    const existing = map.get(entity.id);
    if (!existing) {
      map.set(entity.id, {
        entity,
        score: input.score,
        kind: input.kind,
        chains: [input.chain]
      });
      return;
    }

    existing.score = Math.max(existing.score, input.score);
    if (existing.kind !== input.kind) {
      existing.kind = `${existing.kind},${input.kind}`;
    }
    existing.chains.push(input.chain);
  }

  private sortCandidates(values: ImpactCandidate[]) {
    return values.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return a.entity.canonicalName.localeCompare(b.entity.canonicalName);
    });
  }

  private edgeTouchesEntityPair(edge: KnowledgeEdge, a: string, b: string) {
    return (edge.fromEntityId === a && edge.toEntityId === b) || (edge.fromEntityId === b && edge.toEntityId === a);
  }

  private async resolveCompanySeed(orgId: string, companyName: string): Promise<KnowledgeEntity | null> {
    const company = await this.graph.resolveEntity(orgId, companyName, KnowledgeEntityType.company);
    if (company) {
      return company;
    }

    const instrument = await this.graph.resolveEntity(orgId, companyName, KnowledgeEntityType.instrument);
    if (!instrument) {
      return null;
    }

    const edges = await this.prisma.knowledgeEdge.findMany({
      where: {
        orgId,
        type: KnowledgeRelationType.has_ticker,
        OR: [{ fromEntityId: instrument.id }, { toEntityId: instrument.id }]
      },
      orderBy: [{ weight: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
      take: 20
    });

    const candidateIds = new Set<string>();
    for (const edge of edges) {
      const otherId = edge.fromEntityId === instrument.id ? edge.toEntityId : edge.fromEntityId;
      candidateIds.add(otherId);
    }

    const entities = await this.prisma.knowledgeEntity.findMany({
      where: { id: { in: Array.from(candidateIds) } }
    });

    const companies = entities.filter((entity) => entity.type === KnowledgeEntityType.company);
    return companies[0] ?? null;
  }

  private async findRelatedEntities(input: {
    orgId: string;
    seedId: string;
    relationTypes: KnowledgeRelationType[];
    limit: number;
  }): Promise<{ edges: KnowledgeEdge[]; nodesById: Map<string, KnowledgeEntity> }> {
    const edges = await this.prisma.knowledgeEdge.findMany({
      where: {
        orgId: input.orgId,
        type: { in: input.relationTypes },
        OR: [{ fromEntityId: input.seedId }, { toEntityId: input.seedId }]
      },
      orderBy: [{ confidence: "desc" }, { weight: "desc" }, { updatedAt: "desc" }],
      take: input.limit
    });

    const ids = new Set<string>([input.seedId]);
    for (const edge of edges) {
      ids.add(edge.fromEntityId);
      ids.add(edge.toEntityId);
    }

    const nodes = await this.prisma.knowledgeEntity.findMany({
      where: { id: { in: Array.from(ids) } }
    });

    return { edges, nodesById: new Map(nodes.map((node) => [node.id, node])) };
  }

  private async fetchLatestLprSnapshot(): Promise<Record<string, unknown>> {
    const payload = await this.akshare.get<unknown>("/macro_china_lpr");
    const rows = this.toRecordArray(payload);
    if (rows.length === 0) {
      return {};
    }

    const pick = (row: Record<string, unknown>, keys: string[]) => {
      for (const key of keys) {
        const value = row[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
      return null;
    };

    const sorted = rows
      .map((row) => ({
        date: pick(row, ["date", "\u65e5\u671f", "time"]) as string | null,
        lpr1y: pick(row, ["LPR_1Y", "LPR 1Y", "1Y", "lpr_1y", "lpr_1year", "LPR\u4e001\u5e74"]),
        lpr5y: pick(row, ["LPR_5Y", "LPR 5Y", "5Y", "lpr_5y", "lpr_5year", "LPR\u4e005\u5e74"])
      }))
      .filter((row) => typeof row.date === "string" && row.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const latest = sorted[sorted.length - 1] ?? null;
    const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

    return {
      latest,
      previous: prev
    };
  }

  private toRecordArray(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return payload.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)
      );
    }

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const nested = record.data;
      if (Array.isArray(nested)) {
        return nested.filter(
          (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)
        );
      }
      return [record];
    }

    return [];
  }
}
