import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { KnowledgeRecordSource } from "@prisma/client";

import { AkshareGatewayClient } from "../akshare/akshare-gateway.client";

import { KnowledgeGraphService, type SeedRelationInput } from "./knowledge-graph.service";

const logger = createLogger({ name: "knowledge-graph-seed" });

const SW_STOCK_CODE_KEY = "\u80a1\u7968\u4ee3\u7801";
const SW_STOCK_NAME_KEY = "\u80a1\u7968\u7b80\u79f0";
const SW_LEVEL1_KEY = "\u7533\u4e071\u7ea7";
const SW_LEVEL2_KEY = "\u7533\u4e072\u7ea7";
const SW_LEVEL3_KEY = "\u7533\u4e073\u7ea7";

export interface SwSeedBatchInput {
  orgId: string;
  startAfterSymbol?: string | null;
  maxIndustries: number;
}

export interface SwSeedBatchResult {
  processedIndustries: number;
  lastSymbol: string | null;
  relationsUpserted: number;
}

@Injectable()
export class KnowledgeGraphSeedService {
  constructor(
    private readonly akshare: AkshareGatewayClient,
    private readonly graph: KnowledgeGraphService
  ) {}

  async ingestSwThirdLevelIndustryBatch(input: SwSeedBatchInput): Promise<SwSeedBatchResult> {
    const symbols = await this.fetchSwThirdLevelSymbols();
    if (symbols.length === 0) {
      return { processedIndustries: 0, lastSymbol: null, relationsUpserted: 0 };
    }

    const ordered = symbols.slice().sort();
    const startAfter = input.startAfterSymbol?.trim() ?? null;
    let startIndex = 0;
    if (startAfter) {
      const idx = ordered.findIndex((symbol) => symbol === startAfter);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }

    const selected = ordered.slice(startIndex, startIndex + Math.max(0, input.maxIndustries));
    if (selected.length === 0) {
      return { processedIndustries: 0, lastSymbol: startAfter, relationsUpserted: 0 };
    }

    let relationsUpserted = 0;

    for (const symbol of selected) {
      const relations = await this.buildSwIndustryRelations(symbol);
      if (relations.length === 0) {
        logger.warn({ orgId: input.orgId, symbol }, "SW seed: no relations generated for symbol");
        continue;
      }

      const result = await this.graph.ingestSeedRelations({
        orgId: input.orgId,
        source: KnowledgeRecordSource.seed,
        relations
      });
      relationsUpserted += result.edgesUpserted;
    }

    return {
      processedIndustries: selected.length,
      lastSymbol: selected[selected.length - 1] ?? null,
      relationsUpserted
    };
  }

  private async fetchSwThirdLevelSymbols(): Promise<string[]> {
    const payload = await this.akshare.get<unknown>("/sw_index_third_info");
    const records = this.toRecordArray(payload);
    const symbols = new Set<string>();

    for (const record of records) {
      for (const value of Object.values(record)) {
        const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
        if (this.isSwIndustrySymbol(text)) {
          symbols.add(text);
        }
      }
    }

    return Array.from(symbols);
  }

  private isSwIndustrySymbol(value: string) {
    return /^\d{6}\.SI$/i.test(value);
  }

  private toRecordArray(payload: unknown): Record<string, unknown>[] {
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

  private readString(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private async buildSwIndustryRelations(industrySymbol: string): Promise<SeedRelationInput[]> {
    const payload = await this.akshare.get<unknown>("/sw_index_third_cons", { symbol: industrySymbol });
    const rows = this.toRecordArray(payload);
    if (rows.length === 0) {
      return [];
    }

    const relations: SeedRelationInput[] = [];
    for (const row of rows) {
      const stockCode = this.readString(row, [SW_STOCK_CODE_KEY, "stock_code", "code"]);
      const stockName = this.readString(row, [SW_STOCK_NAME_KEY, "stock_name", "name"]);
      if (!stockCode || !stockName) {
        continue;
      }

      const level1 = this.readString(row, [SW_LEVEL1_KEY, "SW1", "industry_level_1"]);
      const level2 = this.readString(row, [SW_LEVEL2_KEY, "SW2", "industry_level_2"]);
      const level3 = this.readString(row, [SW_LEVEL3_KEY, "SW3", "industry_level_3"]);

      const company = { name: stockName, type: "company" };
      const instrument = { name: stockCode, type: "instrument" };

      relations.push({
        subject: company,
        predicate: "has_ticker",
        object: instrument,
        confidence: 1,
        properties: {
          provider: "akshare",
          dataset: "sw_index_third_cons",
          industrySymbol
        }
      });

      const levels = [
        { name: level1, level: 1 },
        { name: level2, level: 2 },
        { name: level3, level: 3 }
      ];

      for (const entry of levels) {
        if (!entry.name) {
          continue;
        }
        relations.push({
          subject: company,
          predicate: "belongs_to_industry",
          object: { name: entry.name, type: "industry" },
          confidence: 1,
          properties: {
            provider: "akshare",
            dataset: "sw_index_third_cons",
            industrySymbol,
            level: entry.level
          }
        });
      }
    }

    return relations;
  }
}
