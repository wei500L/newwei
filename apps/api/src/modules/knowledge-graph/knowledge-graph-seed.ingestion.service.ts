import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import { KnowledgeGraphSeedService } from "./knowledge-graph-seed.service";
import { KnowledgeGraphSettingsService } from "./knowledge-graph-settings.service";

const logger = createLogger({ name: "knowledge-graph-seed-ingestion" });

interface SwSeedState {
  lastSymbol: string | null;
  completedAt: string | null;
}

const SW_SEED_STATE_KEY_PREFIX = "knowledge_graph_seed_sw_state:";

@Injectable()
export class KnowledgeGraphSeedIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly seed: KnowledgeGraphSeedService
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async ingestSeedData() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true }
    });

    for (const org of orgs) {
      try {
        await this.ingestOrg(org.id);
      } catch (error) {
        logger.warn({ err: error, orgId: org.id }, "Knowledge graph seed ingestion failed");
      }
    }
  }

  private async ingestOrg(orgId: string) {
    const settings = await this.settings.getSettings(orgId);
    if (!settings.enabled || !settings.seedIngestionEnabled) {
      return;
    }

    const state = await this.loadState(orgId);
    if (state.completedAt) {
      return;
    }

    const batch = await this.seed.ingestSwThirdLevelIndustryBatch({
      orgId,
      startAfterSymbol: state.lastSymbol,
      maxIndustries: settings.seedSwIndustriesPerRun
    });

    if (batch.processedIndustries === 0) {
      await this.saveState(orgId, {
        lastSymbol: state.lastSymbol,
        completedAt: new Date().toISOString()
      });
      logger.info({ orgId }, "Knowledge graph SW seed ingestion completed");
      return;
    }

    await this.saveState(orgId, {
      lastSymbol: batch.lastSymbol,
      completedAt: null
    });

    logger.info(
      { orgId, processedIndustries: batch.processedIndustries, relationsUpserted: batch.relationsUpserted, lastSymbol: batch.lastSymbol },
      "Knowledge graph SW seed ingestion progressed"
    );
  }

  private stateKey(orgId: string) {
    return `${SW_SEED_STATE_KEY_PREFIX}${orgId}`;
  }

  private parseState(value: unknown): SwSeedState {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { lastSymbol: null, completedAt: null };
    }
    const record = value as Record<string, unknown>;
    const lastSymbol = typeof record.lastSymbol === "string" ? record.lastSymbol : null;
    const completedAt = typeof record.completedAt === "string" ? record.completedAt : null;
    return { lastSymbol, completedAt };
  }

  private async loadState(orgId: string): Promise<SwSeedState> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.stateKey(orgId) }
    });
    return this.parseState(record?.value);
  }

  private async saveState(orgId: string, state: SwSeedState) {
    await this.prisma.systemSetting.upsert({
      where: { key: this.stateKey(orgId) },
      update: {
        value: toPrismaJsonValue(state),
        description: `Knowledge graph SW seed state (org=${orgId})`
      },
      create: {
        key: this.stateKey(orgId),
        value: toPrismaJsonValue(state),
        description: `Knowledge graph SW seed state (org=${orgId})`
      }
    });
  }
}
