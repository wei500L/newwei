import { ItemReadModelModel, type ItemReadModel } from "@modular/mongo";
import { Client } from "@elastic/elasticsearch";
import { Injectable, OnModuleInit } from "@nestjs/common";

import { EnvService } from "../config/config.service";
import { recordIntegrationEvent } from "../observability/prometheus-metrics";

export interface ItemSearchHit {
  id: string;
  score: number;
  highlights: Record<string, string[]>;
}

export interface ItemLiteralKeywordSearchOptions {
  createdAtGte?: Date;
  limit?: number;
}

export interface ItemSearchReindexResult {
  indexed: number;
  index: string;
  alias: string;
}

interface ItemSearchDocument {
  orgId: string;
  itemMetaId: string;
  title: string;
  externalId: string;
  sourceName?: string | null;
  summary?: string | null;
  topics: string[];
  entities: string[];
  region?: string | null;
  location?: string | null;
  sentiment?: string | null;
  contentType?: string | null;
  searchText: string;
  sortAt: string;
  createdAt: string;
}

const FIELD_ALIASES: Record<string, string> = {
  title: "title",
  source: "sourceName",
  sourceName: "sourceName",
  summary: "summary",
  topic: "topics",
  topics: "topics",
  entity: "entities",
  entities: "entities",
  region: "region",
  location: "location",
  sentiment: "sentiment",
  type: "contentType",
  contentType: "contentType",
  id: "externalId",
};

function rewriteFieldAliases(query: string): string {
  return query.replace(/\b([A-Za-z][A-Za-z0-9_]*):/g, (match, field: string) => {
    const mapped = FIELD_ALIASES[field];
    return mapped ? `${mapped}:` : match;
  });
}

function extractHighlights(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [field, snippets] of Object.entries(value)) {
    if (!Array.isArray(snippets)) {
      continue;
    }
    const normalized = snippets
      .filter((snippet): snippet is string => typeof snippet === "string")
      .slice(0, 3);
    if (normalized.length > 0) {
      result[field] = normalized;
    }
  }
  return result;
}

function normalizeLiteralKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const keyword of keywords) {
    if (typeof keyword !== "string") {
      continue;
    }
    const trimmed = keyword.trim().replace(/\s+/g, " ").slice(0, 128);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 50) {
      break;
    }
  }
  return out;
}

@Injectable()
export class ItemsElasticsearchService implements OnModuleInit {
  private readonly client: Client | null;

  constructor(private readonly env: EnvService) {
    const config = env.elasticsearchConfig;
    if (!config.enabled || !config.node) {
      this.client = null;
      return;
    }

    this.client = new Client({
      node: config.node,
      requestTimeout: config.requestTimeoutMs,
      auth: config.apiKey
        ? { apiKey: config.apiKey }
        : config.username && config.password
          ? { username: config.username, password: config.password }
          : undefined,
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.ensureIndex().catch(() => undefined);
  }

  enabled(): boolean {
    return Boolean(this.client);
  }

  async searchLiteralKeywords(
    orgId: string,
    keywords: string[],
    options: ItemLiteralKeywordSearchOptions = {},
  ): Promise<ItemSearchHit[] | null> {
    const normalized = normalizeLiteralKeywords(keywords);
    if (!this.client) {
      return null;
    }
    if (normalized.length === 0) {
      return [];
    }
    try {
      await this.ensureIndex();
      const filters: Record<string, unknown>[] = [{ term: { orgId } }];
      if (
        options.createdAtGte instanceof Date &&
        Number.isFinite(options.createdAtGte.getTime())
      ) {
        filters.push({
          range: { createdAt: { gte: options.createdAtGte.toISOString() } },
        });
      }
      const response = await this.client.search<ItemSearchDocument>({
        index: this.env.elasticsearchConfig.itemsAlias,
        size: this.normalizeSearchLimit(options.limit),
        query: {
          bool: {
            filter: filters,
            should: normalized.map((keyword) => ({
              multi_match: {
                query: keyword,
                type: "phrase",
                fields: [
                  "title^4",
                  "summary^2",
                  "sourceName^2",
                  "topics^2",
                  "entities^2",
                  "searchText",
                ],
              },
            })),
            minimum_should_match: 1,
          },
        },
        sort: [{ _score: { order: "desc" } }, { sortAt: { order: "desc" } }],
      });
      recordIntegrationEvent({
        integration: "elasticsearch",
        operation: "items_literal_keyword_search",
        status: "success",
      });
      return response.hits.hits
        .map((hit) => ({
          id: hit._source?.itemMetaId ?? "",
          score: typeof hit._score === "number" ? hit._score : 0,
          highlights: extractHighlights(hit.highlight),
        }))
        .filter((hit) => hit.id.length > 0);
    } catch {
      recordIntegrationEvent({
        integration: "elasticsearch",
        operation: "items_literal_keyword_search",
        status: "failure",
      });
      return null;
    }
  }

  async search(orgId: string, query: string, limit = 500): Promise<ItemSearchHit[] | null> {
    if (!this.client || !query.trim()) {
      return null;
    }
    try {
      await this.ensureIndex();
      const response = await this.client.search<ItemSearchDocument>({
        index: this.env.elasticsearchConfig.itemsAlias,
        size: this.normalizeSearchLimit(limit),
        query: {
          bool: {
            filter: [{ term: { orgId } }],
            must: [
              {
                query_string: {
                  query: rewriteFieldAliases(query.trim()),
                  fields: [
                    "title^4",
                    "summary^2",
                    "sourceName^2",
                    "topics^2",
                    "entities^2",
                    "region",
                    "location",
                    "sentiment",
                    "contentType",
                    "externalId",
                    "searchText",
                  ],
                  default_operator: "AND",
                  lenient: true,
                },
              },
            ],
          },
        },
        highlight: {
          pre_tags: ["<mark>"],
          post_tags: ["</mark>"],
          fields: {
            title: {},
            summary: {},
            sourceName: {},
            topics: {},
            entities: {},
            searchText: { fragment_size: 160, number_of_fragments: 2 },
          },
        },
        sort: [{ _score: { order: "desc" } }, { sortAt: { order: "desc" } }],
      });
      recordIntegrationEvent({
        integration: "elasticsearch",
        operation: "items_search",
        status: "success",
      });
      return response.hits.hits
        .map((hit) => ({
          id: hit._source?.itemMetaId ?? "",
          score: typeof hit._score === "number" ? hit._score : 0,
          highlights: extractHighlights(hit.highlight),
        }))
        .filter((hit) => hit.id.length > 0);
    } catch {
      recordIntegrationEvent({
        integration: "elasticsearch",
        operation: "items_search",
        status: "failure",
      });
      return null;
    }
  }

  private normalizeSearchLimit(limit = 500): number {
    return Math.min(Math.max(Math.floor(limit), 1), 1000);
  }

  async getHighlights(
    orgId: string,
    query: string,
    ids: string[],
  ): Promise<Map<string, Record<string, string[]>>> {
    const idSet = new Set(ids);
    const hits = await this.search(orgId, query, Math.max(ids.length, 1));
    const result = new Map<string, Record<string, string[]>>();
    for (const hit of hits ?? []) {
      if (idSet.has(hit.id)) {
        result.set(hit.id, hit.highlights);
      }
    }
    return result;
  }

  async reindexOrg(orgId: string): Promise<ItemSearchReindexResult> {
    if (!this.client) {
      return {
        indexed: 0,
        index: this.env.elasticsearchConfig.itemsIndex,
        alias: this.env.elasticsearchConfig.itemsAlias,
      };
    }
    await this.ensureIndex();
    let indexed = 0;
    let cursor: string | null = null;
    for (;;) {
      const docs = (await ItemReadModelModel.find(
        {
          orgId,
          ...(cursor ? { itemMetaId: { $gt: cursor } } : {}),
        },
        {},
      )
        .sort({ itemMetaId: 1 })
        .limit(500)
        .lean()) as ItemReadModel[];
      if (docs.length === 0) {
        break;
      }
      const operations = docs.flatMap((doc) => [
        {
          index: {
            _index: this.env.elasticsearchConfig.itemsIndex,
            _id: `${doc.orgId}:${doc.itemMetaId}`,
          },
        },
        this.toDocument(doc),
      ]);
      if (operations.length > 0) {
        await this.client.bulk({ refresh: false, operations });
        indexed += docs.length;
      }
      cursor = docs[docs.length - 1]?.itemMetaId ?? null;
      if (!cursor) {
        break;
      }
    }
    await this.client.indices.refresh({ index: this.env.elasticsearchConfig.itemsIndex });
    return {
      indexed,
      index: this.env.elasticsearchConfig.itemsIndex,
      alias: this.env.elasticsearchConfig.itemsAlias,
    };
  }

  private async ensureIndex(): Promise<void> {
    if (!this.client) {
      return;
    }
    const config = this.env.elasticsearchConfig;
    const exists = await this.client.indices.exists({ index: config.itemsIndex });
    if (!exists) {
      await this.client.indices.create({
        index: config.itemsIndex,
        mappings: {
          properties: {
            orgId: { type: "keyword" },
            itemMetaId: { type: "keyword" },
            externalId: { type: "keyword" },
            title: { type: "text" },
            sourceName: { type: "text", fields: { keyword: { type: "keyword" } } },
            summary: { type: "text" },
            topics: { type: "text", fields: { keyword: { type: "keyword" } } },
            entities: { type: "text", fields: { keyword: { type: "keyword" } } },
            region: { type: "keyword" },
            location: { type: "keyword" },
            sentiment: { type: "keyword" },
            contentType: { type: "keyword" },
            searchText: { type: "text" },
            sortAt: { type: "date" },
            createdAt: { type: "date" },
          },
        },
      });
    }
    const aliasExists = await this.client.indices.existsAlias({
      name: config.itemsAlias,
    });
    if (!aliasExists) {
      await this.client.indices.putAlias({
        index: config.itemsIndex,
        name: config.itemsAlias,
      });
    }
  }

  private toDocument(doc: ItemReadModel): ItemSearchDocument {
    return {
      orgId: doc.orgId,
      itemMetaId: doc.itemMetaId,
      title: doc.title,
      externalId: doc.externalId,
      sourceName: doc.sourceName ?? null,
      summary: doc.summary ?? null,
      topics: Array.isArray(doc.topics) ? doc.topics : [],
      entities: Array.isArray(doc.entities) ? doc.entities : [],
      region: doc.region ?? null,
      location: doc.location ?? null,
      sentiment: doc.sentiment ?? null,
      contentType: doc.contentType ?? null,
      searchText: doc.searchText ?? "",
      sortAt: doc.sortAt.toISOString(),
      createdAt: doc.createdAt.toISOString(),
    };
  }
}
