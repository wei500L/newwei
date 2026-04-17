import { createLogger } from "@modular/utils";
import { Injectable, Optional } from "@nestjs/common";
import {
  KnowledgeEntityType,
  KnowledgeRelationType,
  KnowledgeRecordSource,
  type KnowledgeEdge,
  type KnowledgeEntity,
  type Prisma
} from "@prisma/client";

import { toPrismaJsonValueOrUndefined } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import { KnowledgeGraphEntityDisambiguationService } from "./knowledge-graph-entity-disambiguation.service";

interface KgEntityRef {
  name: string;
  type: string;
}

export interface SeedEntityRef extends KgEntityRef {
  aliases?: string[];
  properties?: Record<string, unknown>;
}

interface EntityMention extends SeedEntityRef {
  confidence: number;
}

interface KgRelationInput {
  subject: KgEntityRef;
  predicate: string;
  object: KgEntityRef;
  confidence: number;
  properties?: Record<string, unknown>;
  evidence?: string | null;
  validation?: Record<string, unknown>;
}

export interface SeedRelationInput {
  subject: SeedEntityRef;
  predicate: string;
  object: SeedEntityRef;
  confidence?: number;
  properties?: Record<string, unknown>;
}

export interface IngestProcessedArticleInput {
  orgId: string;
  articleId: string;
  extractorVersion?: string | null;
  kgRelations: unknown;
  maxRelationsPerArticle: number;
}

export interface LinkArticleEntitiesInput {
  orgId: string;
  articleId: string;
  extractorVersion?: string | null;
  entities: unknown;
  maxEntitiesPerArticle: number;
  minConfidence: number;
  createMissingEntities?: boolean;
  disambiguationEnabled?: boolean;
  disambiguationContextText?: string;
  disambiguationMaxCandidates?: number;
}

export interface IngestSeedRelationsInput {
  orgId: string;
  source: KnowledgeRecordSource;
  relations: SeedRelationInput[];
}

export interface KnowledgeGraphSubgraphInput {
  orgId: string;
  seedName: string;
  seedType?: KnowledgeEntityType;
  maxDepth: number;
  maxNodes: number;
  relationTypes?: KnowledgeRelationType[];
}

export interface KnowledgeGraphSubgraphResult {
  seed: KnowledgeEntity;
  nodes: KnowledgeEntity[];
  edges: KnowledgeEdge[];
}

export interface KnowledgeGraphEdgeEvidenceResult {
  id: string;
  confidence: number | null;
  extractorVersion: string | null;
  createdAt: Date;
  evidence: Record<string, unknown> | null;
  article: {
    id: string;
    url: string;
    title: string | null;
    summary: string | null;
    language: string | null;
    crawlAt: Date;
  };
}

@Injectable()
export class KnowledgeGraphService {
  private readonly logger = createLogger({ name: "knowledge-graph" });

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly disambiguation?: KnowledgeGraphEntityDisambiguationService
  ) {}

  async resolveEntity(orgId: string, name: string, type?: KnowledgeEntityType): Promise<KnowledgeEntity | null> {
    return this.resolveEntityByName(orgId, name, type);
  }

  async listArticleEntityLinks(orgId: string, articleId: string, limit: number) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.articleEntityLink.findMany({
      where: { orgId, articleId },
      orderBy: { createdAt: "desc" },
      take,
      include: { entity: true }
    });
  }

  async listEdgeEvidence(
    orgId: string,
    edgeId: string,
    limit: number
  ): Promise<KnowledgeGraphEdgeEvidenceResult[]> {
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await this.prisma.knowledgeEdgeEvidence.findMany({
      where: { orgId, edgeId },
      take,
      orderBy: [{ article: { crawlAt: "desc" } }, { createdAt: "desc" }],
      include: {
        article: {
          include: {
            processed: true
          }
        }
      }
    });

    return rows.map((row) => {
      const processed = row.article.processed;
      const evidence =
        row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
          ? (row.evidence as Record<string, unknown>)
          : null;

      return {
        id: row.id,
        confidence: row.confidence ?? null,
        extractorVersion: row.extractorVersion ?? null,
        createdAt: row.createdAt,
        evidence,
        article: {
          id: row.articleId,
          url: row.article.url,
          title: processed?.title ?? row.article.titleGuess ?? null,
          summary: processed?.summary ?? null,
          language: processed?.language ?? row.article.language ?? null,
          crawlAt: row.article.crawlAt
        }
      };
    });
  }

  async ingestProcessedArticle(input: IngestProcessedArticleInput): Promise<{ edgesUpserted: number }> {
    const relations = this.parseRelations(input.kgRelations).slice(0, input.maxRelationsPerArticle);
    if (relations.length === 0) {
      return { edgesUpserted: 0 };
    }

    const now = new Date();

    const edgesUpserted = await this.prisma.runInTransaction(async (tx) => {
      let processed = 0;
      for (const relation of relations) {
        const edgeType = this.normalizeRelationType(relation.predicate);
        if (!edgeType) {
          continue;
        }

        const from = await this.upsertEntity(tx, input.orgId, relation.subject, { source: KnowledgeRecordSource.llm });
        const to = await this.upsertEntity(tx, input.orgId, relation.object, { source: KnowledgeRecordSource.llm });

        const edge = await this.upsertEdge(tx, {
          orgId: input.orgId,
          type: edgeType,
          fromEntityId: from.id,
          toEntityId: to.id,
          confidence: relation.confidence,
          properties: relation.properties,
          now,
          mode: "observe"
        });

        await this.upsertEdgeEvidence(tx, {
          orgId: input.orgId,
          edgeId: edge.id,
          articleId: input.articleId,
          extractorVersion: input.extractorVersion ?? null,
          confidence: relation.confidence,
          evidence: relation.evidence ?? null,
          validation: relation.validation
        });

        processed += 1;
      }
      return processed;
    });

    return { edgesUpserted };
  }

  async linkArticleEntities(input: LinkArticleEntitiesInput): Promise<{ linksUpserted: number }> {
    const entities = this.parseEntities(input.entities)
      .filter((entity) => entity.confidence >= input.minConfidence)
      .slice(0, input.maxEntitiesPerArticle);
    if (entities.length === 0) {
      return { linksUpserted: 0 };
    }

    const now = new Date();
    const createThreshold = Math.max(input.minConfidence, 0.85);
    const disambiguationThreshold = createThreshold;
    const disambiguationContext =
      typeof input.disambiguationContextText === "string" ? input.disambiguationContextText.trim() : "";
    const shouldDisambiguate =
      Boolean(input.disambiguationEnabled) && Boolean(this.disambiguation) && disambiguationContext.length > 0;
    const maxCandidates = Math.min(
      20,
      Math.max(2, Math.round(typeof input.disambiguationMaxCandidates === "number" ? input.disambiguationMaxCandidates : 5))
    );

    const linksUpserted = await this.prisma.runInTransaction(async (tx) => {
      const linkRows: {
        orgId: string;
        articleId: string;
        entityId: string;
        mention: string;
        confidence: number;
        source: KnowledgeRecordSource;
        createdAt: Date;
      }[] = [];

      for (const mention of entities) {
        const resolvedType = this.normalizeEntityType(mention.type);
        const candidates = await this.listEntityCandidatesByName(input.orgId, mention.name, resolvedType);
        let entity = candidates[0] ?? null;

        if (
          entity &&
          shouldDisambiguate &&
          mention.confidence >= disambiguationThreshold &&
          candidates.length > 1
        ) {
          const picked = await this.disambiguation?.chooseEntityId({
            orgId: input.orgId,
            mention: { name: mention.name, type: resolvedType },
            contextText: disambiguationContext.slice(0, 4_000),
            candidates: candidates.slice(0, maxCandidates).map((candidate) => ({
              id: candidate.id,
              name: candidate.canonicalName,
              type: candidate.type
            }))
          });
          if (picked?.entityId) {
            const match = candidates.find((candidate) => candidate.id === picked.entityId);
            if (match) {
              entity = match;
            }
          }
        }

        if (!entity && input.createMissingEntities) {
          const shouldCreate =
            mention.confidence >= createThreshold &&
            mention.name.trim().length >= 2 &&
            mention.name.trim().length <= 100;
          if (shouldCreate) {
            entity = await this.upsertEntity(tx, input.orgId, mention, { source: KnowledgeRecordSource.llm });
          }
        }
        if (!entity) {
          continue;
        }

        linkRows.push({
          orgId: input.orgId,
          articleId: input.articleId,
          entityId: entity.id,
          mention: mention.name,
          confidence: mention.confidence,
          source: KnowledgeRecordSource.llm,
          createdAt: now
        });
      }

      if (linkRows.length === 0) {
        return 0;
      }

      const result = await tx.articleEntityLink.createMany({
        data: linkRows,
        skipDuplicates: true
      });
      return result.count ?? 0;
    });

    return { linksUpserted };
  }

  async ingestSeedRelations(input: IngestSeedRelationsInput): Promise<{ edgesUpserted: number }> {
    const relations = Array.isArray(input.relations) ? input.relations : [];
    if (relations.length === 0) {
      return { edgesUpserted: 0 };
    }

    const now = new Date();

    const edgesUpserted = await this.prisma.runInTransaction(async (tx) => {
      let processed = 0;
      for (const relation of relations) {
        const edgeType = this.normalizeRelationType(relation.predicate);
        if (!edgeType) {
          continue;
        }

        const from = await this.upsertEntity(tx, input.orgId, relation.subject, { source: input.source });
        const to = await this.upsertEntity(tx, input.orgId, relation.object, { source: input.source });

        const confidence = this.toConfidence(relation.confidence ?? 1) ?? 1;
        const mergedProperties = relation.properties
          ? { ...relation.properties, recordSource: input.source }
          : { recordSource: input.source };

        await this.upsertEdge(tx, {
          orgId: input.orgId,
          type: edgeType,
          fromEntityId: from.id,
          toEntityId: to.id,
          confidence,
          properties: mergedProperties,
          now,
          mode: "static"
        });

        processed += 1;
      }
      return processed;
    });

    return { edgesUpserted };
  }

  async getSubgraph(input: KnowledgeGraphSubgraphInput): Promise<KnowledgeGraphSubgraphResult | null> {
    const seed = await this.resolveEntityByName(input.orgId, input.seedName, input.seedType);
    if (!seed) {
      return null;
    }

    const nodesById = new Map<string, KnowledgeEntity>([[seed.id, seed]]);
    const edgesById = new Map<string, KnowledgeEdge>();
    const visited = new Set<string>();

    let frontier = new Set<string>([seed.id]);
    let depth = 0;

    while (frontier.size > 0 && depth < input.maxDepth && nodesById.size < input.maxNodes) {
      const frontierIds = Array.from(frontier).filter((id) => !visited.has(id));
      if (frontierIds.length === 0) {
        break;
      }
      frontierIds.forEach((id) => visited.add(id));
      frontier = new Set<string>();

      const edges = await this.prisma.knowledgeEdge.findMany({
        where: {
          orgId: input.orgId,
          ...(input.relationTypes && input.relationTypes.length > 0
            ? { type: { in: input.relationTypes } }
            : {}),
          OR: [{ fromEntityId: { in: frontierIds } }, { toEntityId: { in: frontierIds } }]
        },
        orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
        take: Math.max(50, input.maxNodes * 5)
      });

      const neighborIds = new Set<string>();
      for (const edge of edges) {
        edgesById.set(edge.id, edge);
        neighborIds.add(edge.fromEntityId);
        neighborIds.add(edge.toEntityId);
      }

      const missing = Array.from(neighborIds).filter((id) => !nodesById.has(id));
      if (missing.length > 0) {
        const loaded = await this.prisma.knowledgeEntity.findMany({
          where: { id: { in: missing } }
        });
        for (const node of loaded) {
          nodesById.set(node.id, node);
        }
      }

      for (const edge of edges) {
        if (nodesById.size >= input.maxNodes) break;

        if (!visited.has(edge.fromEntityId) && nodesById.has(edge.fromEntityId)) {
          frontier.add(edge.fromEntityId);
        }
        if (!visited.has(edge.toEntityId) && nodesById.has(edge.toEntityId)) {
          frontier.add(edge.toEntityId);
        }
      }

      depth += 1;
    }

    const nodes = Array.from(nodesById.values()).slice(0, input.maxNodes);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = Array.from(edgesById.values()).filter(
      (edge) => nodeIds.has(edge.fromEntityId) && nodeIds.has(edge.toEntityId)
    );

    return { seed, nodes, edges };
  }

  private async resolveEntityByName(orgId: string, name: string, type?: KnowledgeEntityType) {
    const candidates = await this.listEntityCandidatesByName(orgId, name, type);
    return candidates[0] ?? null;
  }

  private async listEntityCandidatesByName(orgId: string, name: string, type?: KnowledgeEntityType) {
    const normalizedAliases = this.normalizeSearchKeys(name);
    if (normalizedAliases.length === 0) {
      return [];
    }

    const candidates = await this.prisma.knowledgeEntityAlias.findMany({
      where: {
        orgId,
        normalizedAlias: { in: normalizedAliases }
      },
      include: {
        entity: true
      },
      take: 20
    });

    const entities = candidates
      .map((candidate) => ({
        entity: candidate.entity,
        aliasSource: candidate.source as KnowledgeRecordSource
      }))
      .filter((candidate) => (type ? candidate.entity.type === type : true));

    if (entities.length === 0) {
      return [];
    }

    const preference: KnowledgeEntityType[] = [
      KnowledgeEntityType.company,
      KnowledgeEntityType.commodity,
      KnowledgeEntityType.policy,
      KnowledgeEntityType.industry,
      KnowledgeEntityType.person,
      KnowledgeEntityType.instrument,
      KnowledgeEntityType.organization
    ];

    const sourcePreference: KnowledgeRecordSource[] = [
      KnowledgeRecordSource.user,
      KnowledgeRecordSource.seed,
      KnowledgeRecordSource.derived,
      KnowledgeRecordSource.llm
    ];

    const tickerQuery = this.looksLikeTicker(name);

    entities.sort((left, right) => {
      const leftEntity = left.entity;
      const rightEntity = right.entity;

      if (tickerQuery) {
        if (leftEntity.type === KnowledgeEntityType.instrument && rightEntity.type !== KnowledgeEntityType.instrument) {
          return -1;
        }
        if (rightEntity.type === KnowledgeEntityType.instrument && leftEntity.type !== KnowledgeEntityType.instrument) {
          return 1;
        }
      }

      const leftSourceRank = sourcePreference.indexOf(left.aliasSource);
      const rightSourceRank = sourcePreference.indexOf(right.aliasSource);
      const sourceDiff =
        (leftSourceRank === -1 ? sourcePreference.length : leftSourceRank) -
        (rightSourceRank === -1 ? sourcePreference.length : rightSourceRank);
      if (sourceDiff !== 0) {
        return sourceDiff;
      }

      const leftRank = preference.indexOf(leftEntity.type);
      const rightRank = preference.indexOf(rightEntity.type);
      return (leftRank === -1 ? preference.length : leftRank) - (rightRank === -1 ? preference.length : rightRank);
    });

    return entities.map((candidate) => candidate.entity);
  }

  private parseEntities(raw: unknown): EntityMention[] {
    if (raw === null || raw === undefined) {
      return [];
    }
    if (typeof raw === "string") {
      try {
        return this.parseEntities(JSON.parse(raw));
      } catch {
        return [];
      }
    }
    const list = Array.isArray(raw) ? raw : [];
    const results: EntityMention[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const type = typeof record.type === "string" ? record.type.trim() : "";
      const confidence = typeof record.confidence === "number" ? record.confidence : null;
      if (!name || !type) {
        continue;
      }
      if (confidence === null || !Number.isFinite(confidence)) {
        continue;
      }
      results.push({ name, type, confidence });
    }
    return results;
  }

  private parseRelations(value: unknown): KgRelationInput[] {
    if (value === null || value === undefined) {
      return [];
    }
    if (typeof value === "string") {
      try {
        return this.parseRelations(JSON.parse(value));
      } catch {
        return [];
      }
    }
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized: KgRelationInput[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const subject = this.parseEntityRef(record.subject);
      const object = this.parseEntityRef(record.object);
      const predicate = typeof record.predicate === "string" ? record.predicate.trim() : "";
      const confidence = this.toConfidence(record.confidence);
      const properties = this.toOptionalObject(record.properties);
      const evidence = typeof record.evidence === "string" ? record.evidence.trim() : null;
      const validation = this.toOptionalObject(record.validation);

      if (!subject || !object || !predicate || confidence === null) {
        continue;
      }

      normalized.push({
        subject,
        object,
        predicate,
        confidence,
        properties,
        evidence: evidence && evidence.length > 0 ? evidence : null,
        validation
      });
    }

    return normalized;
  }

  private parseEntityRef(value: unknown): KgEntityRef | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (!name || !type) {
      return null;
    }
    return { name, type };
  }

  private toConfidence(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  private toOptionalObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private normalizeRelationType(value: string): KnowledgeRelationType | null {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!normalized) {
      return null;
    }

    switch (normalized) {
      case "belongs_to_industry":
      case "belong_to_industry":
        return KnowledgeRelationType.belongs_to_industry;
      case "supplies":
      case "supplier_of":
        return KnowledgeRelationType.supplies;
      case "customer_of":
      case "buys_from":
        return KnowledgeRelationType.customer_of;
      case "competes_with":
      case "competitor_of":
        return KnowledgeRelationType.competes_with;
      case "holds_position":
      case "works_for":
      case "employed_by":
        return KnowledgeRelationType.holds_position;
      case "affects_industry":
        return KnowledgeRelationType.affects_industry;
      case "affects_company":
        return KnowledgeRelationType.affects_company;
      case "upstream_of":
        return KnowledgeRelationType.upstream_of;
      case "downstream_of":
        return KnowledgeRelationType.downstream_of;
      case "has_ticker":
      case "ticker_of":
        return KnowledgeRelationType.has_ticker;
      default:
        return null;
    }
  }

  private normalizeEntityType(value: string): KnowledgeEntityType {
    const type = value.trim().toLowerCase();
    if (!type) {
      return KnowledgeEntityType.organization;
    }

    if (type.includes("person") || type.includes("people")) {
      return KnowledgeEntityType.person;
    }
    if (type.includes("policy") || type.includes("regulation") || type.includes("law")) {
      return KnowledgeEntityType.policy;
    }
    if (type.includes("industry") || type.includes("sector")) {
      return KnowledgeEntityType.industry;
    }
    if (type.includes("commodity")) {
      return KnowledgeEntityType.commodity;
    }
    if (
      type.includes("stock") ||
      type.includes("equity") ||
      type.includes("index") ||
      type.includes("ticker") ||
      type.includes("future") ||
      type.includes("etf")
    ) {
      return KnowledgeEntityType.instrument;
    }
    if (type.includes("company") || type.includes("corp") || type.includes("inc")) {
      return KnowledgeEntityType.company;
    }
    if (type.includes("org") || type.includes("organization") || type.includes("institution")) {
      return KnowledgeEntityType.organization;
    }

    return KnowledgeEntityType.organization;
  }

  private normalizeEntityKey(value: string) {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  private normalizeSearchKeys(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const keys = new Set<string>();
    keys.add(this.normalizeEntityKey(trimmed));

    for (const alias of this.buildCompanyAliasCandidates(trimmed)) {
      keys.add(this.normalizeEntityKey(alias));
    }

    const tickerAliases = this.buildTickerAliases(trimmed);
    for (const alias of tickerAliases) {
      keys.add(this.normalizeEntityKey(alias));
    }

    return Array.from(keys).filter((key) => key.length > 0).slice(0, 20);
  }

  private looksLikeTicker(value: string) {
    return Boolean(this.parseTicker(value));
  }

  private parseTicker(value: string): { code: string; exchange?: "SH" | "SZ" | "BJ" } | null {
    const normalized = value.trim().toUpperCase();
    const dot = /^(\d{6})\.(SH|SZ|BJ)$/.exec(normalized);
    if (dot) {
      const code = dot[1];
      const exchange = dot[2] as "SH" | "SZ" | "BJ" | undefined;
      if (!code || !exchange) {
        return null;
      }
      return { code, exchange };
    }
    const prefix = /^(SH|SZ|BJ)(\d{6})$/.exec(normalized);
    if (prefix) {
      const code = prefix[2];
      const exchange = prefix[1] as "SH" | "SZ" | "BJ" | undefined;
      if (!code || !exchange) {
        return null;
      }
      return { code, exchange };
    }
    const raw = /^(\d{6})$/.exec(normalized);
    if (raw) {
      const code = raw[1];
      if (!code) {
        return null;
      }
      return { code };
    }
    return null;
  }

  private buildTickerAliases(value: string): string[] {
    const parsed = this.parseTicker(value);
    if (!parsed) {
      return [];
    }

    const aliases = new Set<string>();
    aliases.add(parsed.code);

    if (parsed.exchange) {
      aliases.add(`${parsed.code}.${parsed.exchange}`);
      aliases.add(`${parsed.exchange}${parsed.code}`);
    } else {
      for (const exchange of ["SH", "SZ", "BJ"] as const) {
        aliases.add(`${parsed.code}.${exchange}`);
        aliases.add(`${exchange}${parsed.code}`);
      }
    }

    return Array.from(aliases);
  }

  private buildCompanyAliasCandidates(value: string) {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      return [];
    }

    const aliases = new Set<string>();
    aliases.add(trimmed);

    const withoutBrackets = trimmed
      .replace(/\s*[(\uFF08][^)\uFF09]+[)\uFF09]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (withoutBrackets && withoutBrackets !== trimmed) {
      aliases.add(withoutBrackets);
    }

    const suffixes = [
      "\u80a1\u4efd\u6709\u9650\u516c\u53f8",
      "\u6709\u9650\u8d23\u4efb\u516c\u53f8",
      "\u6709\u9650\u516c\u53f8",
      "\u96c6\u56e2\u80a1\u4efd\u6709\u9650\u516c\u53f8",
      "\u96c6\u56e2\u6709\u9650\u516c\u53f8",
      "\u96c6\u56e2",
      "CO., LTD",
      "CO.,LTD",
      "CO. LTD",
      "CO LTD",
      "COMPANY LIMITED",
      "LIMITED",
      "LTD",
      "INC",
      "CORPORATION",
      "CORP"
    ];

    const upper = withoutBrackets.toUpperCase();
    for (const suffix of suffixes) {
      if (upper.endsWith(suffix)) {
        const candidate = withoutBrackets.slice(0, withoutBrackets.length - suffix.length).trim();
        if (candidate) {
          aliases.add(candidate);
        }
      }
    }

    return Array.from(aliases);
  }

  private async upsertEntity(
    tx: Prisma.TransactionClient,
    orgId: string,
    entity: SeedEntityRef,
    options: { source: KnowledgeRecordSource }
  ) {
    const canonicalName = entity.name.trim().replace(/\s+/g, " ");
    const normalizedKey = this.normalizeEntityKey(canonicalName);
    const type = this.normalizeEntityType(entity.type);

    const record = await tx.knowledgeEntity.upsert({
      where: {
        orgId_type_normalizedKey: {
          orgId,
          type,
          normalizedKey
        }
      },
      update: {
        canonicalName
      },
      create: {
        orgId,
        type,
        canonicalName,
        normalizedKey
      }
    });

    const aliasCandidates = new Set<string>([canonicalName]);
    if (type === KnowledgeEntityType.company) {
      this.buildCompanyAliasCandidates(canonicalName).forEach((alias) => aliasCandidates.add(alias));
    }
    if (type === KnowledgeEntityType.instrument) {
      this.buildTickerAliases(canonicalName).forEach((alias) => aliasCandidates.add(alias));
    }
    if (Array.isArray(entity.aliases)) {
      for (const alias of entity.aliases) {
        if (typeof alias === "string" && alias.trim()) {
          aliasCandidates.add(alias.trim());
        }
      }
    }

    for (const alias of aliasCandidates) {
      const normalizedAlias = this.normalizeEntityKey(alias);
      if (!normalizedAlias) {
        continue;
      }

      await tx.knowledgeEntityAlias.upsert({
        where: {
          entityId_normalizedAlias: {
            entityId: record.id,
            normalizedAlias
          }
        },
        update: {},
        create: {
          orgId,
          entityId: record.id,
          alias,
          normalizedAlias,
          source: options.source
        }
      });
    }

    return record;
  }

  private async upsertEdge(
    tx: Prisma.TransactionClient,
    input: {
      orgId: string;
      type: KnowledgeRelationType;
      fromEntityId: string;
      toEntityId: string;
      confidence: number;
      properties?: Record<string, unknown>;
      now: Date;
      mode: "observe" | "static";
    }
  ) {
    const where = {
      orgId_type_fromEntityId_toEntityId: {
        orgId: input.orgId,
        type: input.type,
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId
      }
    };

    const existing = await tx.knowledgeEdge.findUnique({
      where,
      select: { id: true, weight: true, confidence: true, properties: true, firstSeenAt: true }
    });

    if (!existing) {
      return tx.knowledgeEdge.create({
        data: {
          orgId: input.orgId,
          type: input.type,
          fromEntityId: input.fromEntityId,
          toEntityId: input.toEntityId,
          weight: 1,
          confidence: input.confidence,
          properties: toPrismaJsonValueOrUndefined(input.properties),
          firstSeenAt: input.now,
          lastSeenAt: input.now
        }
      });
    }

    const prevWeight = Number.isFinite(existing.weight) && existing.weight > 0 ? existing.weight : 1;
    const nextWeight = input.mode === "observe" ? prevWeight + 1 : prevWeight;
    const nextConfidence =
      input.mode === "observe"
        ? (existing.confidence * prevWeight + input.confidence) / nextWeight
        : Math.max(existing.confidence, input.confidence);
    const mergedProperties = this.mergeJsonObjects(existing.properties, input.properties);

    return tx.knowledgeEdge.update({
      where: { id: existing.id },
      data: {
        weight: nextWeight,
        confidence: nextConfidence,
        properties: toPrismaJsonValueOrUndefined(mergedProperties),
        lastSeenAt: input.now
      }
    });
  }

  private async upsertEdgeEvidence(
    tx: Prisma.TransactionClient,
    input: {
      orgId: string;
      edgeId: string;
      articleId: string;
      extractorVersion: string | null;
      confidence: number;
      evidence: string | null;
      validation?: Record<string, unknown>;
    }
  ) {
    const evidencePayload: Record<string, unknown> = {};
    if (input.evidence) {
      evidencePayload.quote = input.evidence;
    }
    if (input.validation && Object.keys(input.validation).length > 0) {
      evidencePayload.validation = input.validation;
    }

    const where = {
      edgeId_articleId: {
        edgeId: input.edgeId,
        articleId: input.articleId
      }
    };

    const existing = await tx.knowledgeEdgeEvidence.findUnique({
      where,
      select: { id: true, evidence: true }
    });

    const existingEvidence =
      existing?.evidence && typeof existing.evidence === "object" && !Array.isArray(existing.evidence)
        ? (existing.evidence as Record<string, unknown>)
        : undefined;

    const mergedEvidence =
      existingEvidence || Object.keys(evidencePayload).length > 0
        ? { ...(existingEvidence ?? {}), ...evidencePayload }
        : undefined;

    const evidenceValue = toPrismaJsonValueOrUndefined(mergedEvidence);

    if (!existing) {
      await tx.knowledgeEdgeEvidence.create({
        data: {
          orgId: input.orgId,
          edgeId: input.edgeId,
          articleId: input.articleId,
          extractorVersion: input.extractorVersion,
          confidence: input.confidence,
          evidence: evidenceValue
        }
      });
      return;
    }

    await tx.knowledgeEdgeEvidence.update({
      where: { id: existing.id },
      data: {
        extractorVersion: input.extractorVersion,
        confidence: input.confidence,
        evidence: evidenceValue
      }
    });
  }

  private mergeJsonObjects(
    left: Prisma.JsonValue | null,
    right: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    const leftRecord =
      left && typeof left === "object" && !Array.isArray(left)
        ? (left as Record<string, unknown>)
        : undefined;

    if (!right || Object.keys(right).length === 0) {
      return leftRecord;
    }

    if (!leftRecord) {
      return right;
    }

    return { ...leftRecord, ...right };
  }
}
