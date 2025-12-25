import { DEMO_ECONOMIC_METRICS } from "@modular/config";
import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EconomicDataFrequency, EconomicDataValueType, Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 90;
const SOURCE_FIELD = "value";

@Injectable()
export class DashboardDemoMetricsService implements OnModuleInit {
  private readonly logger = new Logger(DashboardDemoMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === "production") {
      return;
    }

    try {
      await this.refreshDemoMetricsInternal();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to refresh demo dashboard metrics: ${message}`);
    }
  }

  private clampValue(value: number) {
    return Math.max(0, Math.min(100, value));
  }

  private stepValue(value: number, volatility: number) {
    return this.clampValue(value + (Math.random() - 0.5) * volatility);
  }

  async refreshDemoMetrics() {
    if (process.env.NODE_ENV === "production") {
      throw new BadRequestException("Demo metrics refresh is disabled in production.");
    }

    await this.refreshDemoMetricsInternal();
    return true;
  }

  private async refreshDemoMetricsInternal() {
    const now = new Date();

    for (const metric of DEMO_ECONOMIC_METRICS) {
      const category = await this.prisma.economicCategory.upsert({
        where: { key: metric.slug },
        update: { label: metric.displayName },
        create: {
          key: metric.slug,
          label: metric.displayName,
        },
      });

      const item = await this.prisma.economicDataItem.upsert({
        where: { slug: metric.slug },
        update: {
          displayName: metric.displayName,
          sourceFunction: "mock",
          sourceEndpoint: "mock",
          valueType: EconomicDataValueType.index,
          defaultFrequency: EconomicDataFrequency.daily,
        },
        create: {
          slug: metric.slug,
          displayName: metric.displayName,
          sourceFunction: "mock",
          sourceEndpoint: "mock",
          valueType: EconomicDataValueType.index,
          defaultFrequency: EconomicDataFrequency.daily,
        },
      });

      await this.prisma.economicDataItemCategory.upsert({
        where: {
          itemId_categoryId: {
            itemId: item.id,
            categoryId: category.id,
          },
        },
        update: {},
        create: {
          itemId: item.id,
          categoryId: category.id,
        },
      });

      const latestPoint = await this.prisma.economicDataPoint.findFirst({
        where: { itemId: item.id, sourceField: SOURCE_FIELD },
        orderBy: { recordedAt: "desc" },
      });

      const points: Prisma.EconomicDataPointCreateManyInput[] = [];
      if (!latestPoint) {
        let value = metric.baseValue;
        for (let i = HISTORY_DAYS; i >= 0; i--) {
          value = this.stepValue(value, metric.volatility);
          points.push({
            itemId: item.id,
            recordedAt: new Date(now.getTime() - i * DAY_MS),
            dataType: EconomicDataValueType.index,
            value,
            sourceField: SOURCE_FIELD,
          });
        }
      } else {
        let value = Number(latestPoint.value);
        const daysMissing = Math.floor((now.getTime() - latestPoint.recordedAt.getTime()) / DAY_MS);
        for (let i = 1; i <= daysMissing; i++) {
          value = this.stepValue(value, metric.volatility);
          points.push({
            itemId: item.id,
            recordedAt: new Date(latestPoint.recordedAt.getTime() + i * DAY_MS),
            dataType: EconomicDataValueType.index,
            value,
            sourceField: SOURCE_FIELD,
          });
        }
      }

      if (points.length) {
        await this.prisma.economicDataPoint.createMany({
          data: points,
          skipDuplicates: true,
        });
      }
    }
  }
}
