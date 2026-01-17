import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../config/prisma.service";

import { NewsIndicatorAssociationService } from "./news-indicator-association.service";
import { NewsIndicatorSettingsService } from "./news-indicator-settings.service";

const logger = createLogger({ name: "news-indicator-ingestion" });

@Injectable()
export class NewsIndicatorAssociationIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: NewsIndicatorSettingsService,
    private readonly associations: NewsIndicatorAssociationService
  ) {}

  @Cron("0 */6 * * *")
  async refreshAssociations() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true }
    });

    for (const org of orgs) {
      try {
        const cfg = await this.settings.getSettings(org.id);
        if (!cfg.enabled || !cfg.ingestionEnabled) {
          continue;
        }
        await this.associations.refreshOrg(org.id);
      } catch (error) {
        logger.warn({ err: error, orgId: org.id }, "News indicator association refresh failed");
      }
    }
  }
}

