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

  private stepPositive(value: number, volatility: number, min = 0.0001) {
    const next = value + (Math.random() - 0.5) * volatility;
    return Math.max(min, next);
  }

  private async upsertCategory(key: string, label: string) {
    return this.prisma.economicCategory.upsert({
      where: { key },
      update: { label },
      create: { key, label }
    });
  }

  private async upsertItem(options: {
    slug: string;
    displayName: string;
    valueType: EconomicDataValueType;
    defaultUnit?: string | null;
    metadata?: Prisma.InputJsonValue | null;
  }) {
    return this.prisma.economicDataItem.upsert({
      where: { slug: options.slug },
      update: {
        displayName: options.displayName,
        sourceFunction: "mock",
        sourceEndpoint: "mock",
        valueType: options.valueType,
        defaultUnit: options.defaultUnit ?? undefined,
        defaultFrequency: EconomicDataFrequency.daily,
        metadata: options.metadata ?? undefined
      },
      create: {
        slug: options.slug,
        displayName: options.displayName,
        sourceFunction: "mock",
        sourceEndpoint: "mock",
        valueType: options.valueType,
        defaultUnit: options.defaultUnit ?? undefined,
        defaultFrequency: EconomicDataFrequency.daily,
        metadata: options.metadata ?? undefined
      }
    });
  }

  private async ensureItemCategory(itemId: string, categoryId: string) {
    await this.prisma.economicDataItemCategory.upsert({
      where: {
        itemId_categoryId: {
          itemId,
          categoryId
        }
      },
      update: {},
      create: {
        itemId,
        categoryId
      }
    });
  }

  private async seedSingleFieldSeries(options: {
    now: Date;
    itemId: string;
    dataType: EconomicDataValueType;
    sourceField: string;
    unit?: string | null;
    baseValue: number;
    volatility: number;
    min?: number;
  }) {
    const latestPoint = await this.prisma.economicDataPoint.findFirst({
      where: { itemId: options.itemId, sourceField: options.sourceField },
      orderBy: { recordedAt: "desc" }
    });

    const points: Prisma.EconomicDataPointCreateManyInput[] = [];
    if (!latestPoint) {
      let value = options.baseValue;
      for (let i = HISTORY_DAYS; i >= 0; i--) {
        value = this.stepPositive(value, options.volatility, options.min);
        points.push({
          itemId: options.itemId,
          recordedAt: new Date(options.now.getTime() - i * DAY_MS),
          dataType: options.dataType,
          value,
          unit: options.unit ?? undefined,
          sourceField: options.sourceField
        });
      }
    } else {
      let value = Number(latestPoint.value);
      const daysMissing = Math.floor((options.now.getTime() - latestPoint.recordedAt.getTime()) / DAY_MS);
      for (let i = 1; i <= daysMissing; i++) {
        value = this.stepPositive(value, options.volatility, options.min);
        points.push({
          itemId: options.itemId,
          recordedAt: new Date(latestPoint.recordedAt.getTime() + i * DAY_MS),
          dataType: options.dataType,
          value,
          unit: options.unit ?? undefined,
          sourceField: options.sourceField
        });
      }
    }

    if (points.length) {
      await this.prisma.economicDataPoint.createMany({
        data: points,
        skipDuplicates: true
      });
    }
  }

  private async seedOhlcSeries(options: {
    now: Date;
    itemId: string;
    dataType: EconomicDataValueType;
    unit?: string | null;
    baseValue: number;
    volatility: number;
    min?: number;
  }) {
    const latestClose = await this.prisma.economicDataPoint.findFirst({
      where: { itemId: options.itemId, sourceField: "close" },
      orderBy: { recordedAt: "desc" }
    });

    const points: Prisma.EconomicDataPointCreateManyInput[] = [];
    if (!latestClose) {
      let close = options.baseValue;
      for (let i = HISTORY_DAYS; i >= 0; i--) {
        const open = close;
        close = this.stepPositive(open, options.volatility, options.min);
        const spread = Math.abs((Math.random() - 0.5) * options.volatility);
        const high = Math.max(open, close) + spread;
        const low = Math.max(options.min ?? 0.0001, Math.min(open, close) - spread);
        const recordedAt = new Date(options.now.getTime() - i * DAY_MS);
        points.push(
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: open, unit: options.unit ?? undefined, sourceField: "open" },
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: high, unit: options.unit ?? undefined, sourceField: "high" },
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: low, unit: options.unit ?? undefined, sourceField: "low" },
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: close, unit: options.unit ?? undefined, sourceField: "close" }
        );
      }
    } else {
      let close = Number(latestClose.value);
      const daysMissing = Math.floor((options.now.getTime() - latestClose.recordedAt.getTime()) / DAY_MS);
      for (let i = 1; i <= daysMissing; i++) {
        const open = close;
        close = this.stepPositive(open, options.volatility, options.min);
        const spread = Math.abs((Math.random() - 0.5) * options.volatility);
        const high = Math.max(open, close) + spread;
        const low = Math.max(options.min ?? 0.0001, Math.min(open, close) - spread);
        const recordedAt = new Date(latestClose.recordedAt.getTime() + i * DAY_MS);
        points.push(
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: open, unit: options.unit ?? undefined, sourceField: "open" },
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: high, unit: options.unit ?? undefined, sourceField: "high" },
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: low, unit: options.unit ?? undefined, sourceField: "low" },
          { itemId: options.itemId, recordedAt, dataType: options.dataType, value: close, unit: options.unit ?? undefined, sourceField: "close" }
        );
      }
    }

    if (points.length) {
      await this.prisma.economicDataPoint.createMany({
        data: points,
        skipDuplicates: true
      });
    }
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

    const categoryLabels: Record<string, string> = {
      "economic-short": "Economic Short",
      "key-monitor": "Key Monitor"
    };

    const extraCategories = await Promise.all(
      Object.entries(categoryLabels).map(([key, label]) => this.upsertCategory(key, label))
    );
    const categoryIdByKey = new Map(extraCategories.map((category) => [category.key, category.id] as const));

    const fxMetadata = {
      parser: {
        valueFields: [{ field: "latest_price", label: "最新价" }]
      }
    } satisfies Prisma.InputJsonValue;

    const ohlcSeries: {
      slug: string;
      displayName: string;
      categories: string[];
      dataType: EconomicDataValueType;
      unit?: string | null;
      baseValue: number;
      volatility: number;
    }[] = [
      { slug: "sp500_index", displayName: "S&P 500 Index", categories: ["key-monitor"], dataType: EconomicDataValueType.index, unit: null, baseValue: 4700, volatility: 80 },
      { slug: "shanghai_composite_index", displayName: "Shanghai Composite Index", categories: ["economic-short", "key-monitor"], dataType: EconomicDataValueType.index, unit: null, baseValue: 3100, volatility: 50 },
      { slug: "csi300_index", displayName: "CSI 300 Index", categories: ["economic-short"], dataType: EconomicDataValueType.index, unit: null, baseValue: 3600, volatility: 55 },
      { slug: "sz_component_index", displayName: "SZ Component Index", categories: ["economic-short"], dataType: EconomicDataValueType.index, unit: null, baseValue: 9800, volatility: 120 },
      { slug: "csi1000_index", displayName: "CSI 1000 Index", categories: ["economic-short"], dataType: EconomicDataValueType.index, unit: null, baseValue: 5500, volatility: 90 },
      { slug: "gold_futures_main", displayName: "Gold Futures", categories: ["key-monitor"], dataType: EconomicDataValueType.price, unit: "USD", baseValue: 2350, volatility: 35 },
      { slug: "crude_oil_futures_main", displayName: "Crude Oil Futures", categories: ["key-monitor"], dataType: EconomicDataValueType.price, unit: "USD", baseValue: 78, volatility: 4 },
      { slug: "copper_futures_main", displayName: "Copper Futures", categories: ["key-monitor"], dataType: EconomicDataValueType.price, unit: "USD", baseValue: 4.2, volatility: 0.25 }
    ];

    for (const series of ohlcSeries) {
      const item = await this.upsertItem({
        slug: series.slug,
        displayName: series.displayName,
        valueType: series.dataType,
        defaultUnit: series.unit ?? undefined
      });
      for (const categoryKey of series.categories) {
        const categoryId = categoryIdByKey.get(categoryKey);
        if (categoryId) {
          await this.ensureItemCategory(item.id, categoryId);
        }
      }

      await this.seedOhlcSeries({
        now,
        itemId: item.id,
        dataType: series.dataType,
        unit: series.unit ?? undefined,
        baseValue: series.baseValue,
        volatility: series.volatility,
        min: 0.0001
      });
    }

    const latestPriceSeries: {
      slug: string;
      displayName: string;
      categories: string[];
      dataType: EconomicDataValueType;
      unit?: string | null;
      baseValue: number;
      volatility: number;
      metadata?: Prisma.InputJsonValue | null;
    }[] = [
      { slug: "usd_cny_spot", displayName: "USD/CNY Spot", categories: ["economic-short", "key-monitor"], dataType: EconomicDataValueType.fx, unit: "CNY", baseValue: 7.2, volatility: 0.05, metadata: fxMetadata },
      { slug: "eur_cny_spot", displayName: "EUR/CNY Spot", categories: ["economic-short", "key-monitor"], dataType: EconomicDataValueType.fx, unit: "CNY", baseValue: 7.9, volatility: 0.06, metadata: fxMetadata },
      { slug: "bitcoin_spot_price", displayName: "Bitcoin Spot Price", categories: ["economic-short"], dataType: EconomicDataValueType.price, unit: "USD", baseValue: 45_000, volatility: 1800 }
    ];

    for (const series of latestPriceSeries) {
      const item = await this.upsertItem({
        slug: series.slug,
        displayName: series.displayName,
        valueType: series.dataType,
        defaultUnit: series.unit ?? undefined,
        metadata: series.metadata ?? undefined
      });
      for (const categoryKey of series.categories) {
        const categoryId = categoryIdByKey.get(categoryKey);
        if (categoryId) {
          await this.ensureItemCategory(item.id, categoryId);
        }
      }

      await this.seedSingleFieldSeries({
        now,
        itemId: item.id,
        dataType: series.dataType,
        unit: series.unit ?? undefined,
        sourceField: "latest_price",
        baseValue: series.baseValue,
        volatility: series.volatility,
        min: 0.0001
      });
    }

    const fxMidItem = await this.upsertItem({
      slug: "china_fx_mid_rates",
      displayName: "China FX Mid Rates",
      valueType: EconomicDataValueType.fx,
      defaultUnit: "CNY"
    });
    const fxMidCategoryId = categoryIdByKey.get("key-monitor");
    if (fxMidCategoryId) {
      await this.ensureItemCategory(fxMidItem.id, fxMidCategoryId);
    }
    await Promise.all([
      this.seedSingleFieldSeries({
        now,
        itemId: fxMidItem.id,
        dataType: EconomicDataValueType.fx,
        unit: "CNY",
        sourceField: "美元",
        baseValue: 7.1,
        volatility: 0.05,
        min: 0.0001
      }),
      this.seedSingleFieldSeries({
        now,
        itemId: fxMidItem.id,
        dataType: EconomicDataValueType.fx,
        unit: "CNY",
        sourceField: "欧元",
        baseValue: 7.8,
        volatility: 0.05,
        min: 0.0001
      }),
      this.seedSingleFieldSeries({
        now,
        itemId: fxMidItem.id,
        dataType: EconomicDataValueType.fx,
        unit: "CNY",
        sourceField: "日元",
        baseValue: 0.049,
        volatility: 0.002,
        min: 0.0001
      })
    ]);
  }
}
