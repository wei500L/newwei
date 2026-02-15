import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../config/prisma.service";

export interface RecordRssTranslationMetricsInput {
  orgId: string;
  provider: string;
  targetLanguage: string;
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

export interface RssTranslationMetricsDailyRow {
  date: string;
  provider: string;
  targetLanguage: string;
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  cacheHitRate: number;
  failureRate: number;
}

export interface RssTranslationMetricsSummary {
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  cacheHitRate: number;
  failureRate: number;
}

export interface RssTranslationMetricsResponse {
  from: string;
  to: string;
  rows: RssTranslationMetricsDailyRow[];
  summary: RssTranslationMetricsSummary;
}

interface RssTranslationMetricsQueryRawRow {
  date: Date | string;
  provider: string;
  targetLanguage: string;
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

interface RssTranslationMetricsQueryOptions {
  from?: string;
  to?: string;
  provider?: string;
  targetLanguage?: string;
}

const logger = createLogger({ name: "rss-translation-metrics" });
const DEFAULT_DAYS = 14;
const MAX_DAYS = 180;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, deltaDays: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + deltaDays);
  return copy;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeDateInput(value: string | undefined, fallback: Date): Date {
  const raw = (value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date '${raw}', expected YYYY-MM-DD`);
  }
  return startOfUtcDay(parsed);
}

function toSafeInt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.trunc(numeric));
}

function isPrismaMissingTableError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  // Prisma model/query errors.
  if (error.code === "P2021" || error.code === "P2022") {
    return true;
  }

  // `$queryRaw` / `$executeRaw` can raise `P2010` with the underlying database error code.
  // MySQL:
  // - 1146: Table doesn't exist
  // - 1054: Unknown column
  if (error.code === "P2010") {
    const meta = error.meta as Record<string, unknown> | undefined;
    const dbCodeRaw = meta?.code;
    const dbCode = typeof dbCodeRaw === "number" ? String(dbCodeRaw) : String(dbCodeRaw ?? "");
    if (dbCode === "1146" || dbCode === "1054") {
      return true;
    }

    const message = String(meta?.message ?? error.message ?? "");
    if (
      message.includes("RssTranslationMetricsDaily") &&
      (message.includes("doesn't exist") ||
        message.includes("does not exist") ||
        message.includes("Unknown column"))
    ) {
      return true;
    }
  }

  return false;
}

@Injectable()
export class RssTranslationMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async recordDaily(input: RecordRssTranslationMetricsInput): Promise<void> {
    const orgId = input.orgId.trim();
    if (!orgId) {
      return;
    }
    const provider = input.provider.trim().toLowerCase();
    const targetLanguage = input.targetLanguage.trim().toLowerCase();
    if (!provider || !targetLanguage) {
      return;
    }

    const requestCount = toSafeInt(input.requestCount);
    if (requestCount <= 0) {
      return;
    }

    const date = startOfUtcDay(new Date());
    const itemCount = toSafeInt(input.itemCount);
    const textCount = toSafeInt(input.textCount);
    const cacheHitCount = toSafeInt(input.cacheHitCount);
    const cacheMissCount = toSafeInt(input.cacheMissCount);
    const translatedCount = toSafeInt(input.translatedCount);
    const failureCount = toSafeInt(input.failureCount);
    const skipTooLongCount = toSafeInt(input.skipTooLongCount);
    const totalLatencyMs = toSafeInt(input.totalLatencyMs);
    const maxLatencyMs = toSafeInt(input.maxLatencyMs);

    try {
      await this.prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO \`RssTranslationMetricsDaily\` (
            \`id\`,
            \`orgId\`,
            \`date\`,
            \`provider\`,
            \`targetLanguage\`,
            \`requestCount\`,
            \`itemCount\`,
            \`textCount\`,
            \`cacheHitCount\`,
            \`cacheMissCount\`,
            \`translatedCount\`,
            \`failureCount\`,
            \`skipTooLongCount\`,
            \`totalLatencyMs\`,
            \`maxLatencyMs\`,
            \`createdAt\`,
            \`updatedAt\`
          )
          VALUES (
            ${randomUUID()},
            ${orgId},
            ${date},
            ${provider},
            ${targetLanguage},
            ${requestCount},
            ${itemCount},
            ${textCount},
            ${cacheHitCount},
            ${cacheMissCount},
            ${translatedCount},
            ${failureCount},
            ${skipTooLongCount},
            ${totalLatencyMs},
            ${maxLatencyMs},
            CURRENT_TIMESTAMP(3),
            CURRENT_TIMESTAMP(3)
          )
          ON DUPLICATE KEY UPDATE
            \`requestCount\` = \`requestCount\` + VALUES(\`requestCount\`),
            \`itemCount\` = \`itemCount\` + VALUES(\`itemCount\`),
            \`textCount\` = \`textCount\` + VALUES(\`textCount\`),
            \`cacheHitCount\` = \`cacheHitCount\` + VALUES(\`cacheHitCount\`),
            \`cacheMissCount\` = \`cacheMissCount\` + VALUES(\`cacheMissCount\`),
            \`translatedCount\` = \`translatedCount\` + VALUES(\`translatedCount\`),
            \`failureCount\` = \`failureCount\` + VALUES(\`failureCount\`),
            \`skipTooLongCount\` = \`skipTooLongCount\` + VALUES(\`skipTooLongCount\`),
            \`totalLatencyMs\` = \`totalLatencyMs\` + VALUES(\`totalLatencyMs\`),
            \`maxLatencyMs\` = GREATEST(\`maxLatencyMs\`, VALUES(\`maxLatencyMs\`)),
            \`updatedAt\` = CURRENT_TIMESTAMP(3)
        `
      );
    } catch (error) {
      if (isPrismaMissingTableError(error)) {
        logger.warn(
          "RssTranslationMetricsDaily table is missing; run database migrations to enable RSS translation metrics."
        );
        return;
      }
      throw error;
    }
  }

  async getDailyMetrics(
    orgId: string,
    options: RssTranslationMetricsQueryOptions = {}
  ): Promise<RssTranslationMetricsResponse> {
    const normalizedOrgId = orgId.trim();
    const nowDay = startOfUtcDay(new Date());
    const defaultFrom = addUtcDays(nowDay, -(DEFAULT_DAYS - 1));
    const from = normalizeDateInput(options.from, defaultFrom);
    const to = normalizeDateInput(options.to, nowDay);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException("'from' must be earlier than or equal to 'to'");
    }

    const daysWindow = Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (daysWindow > MAX_DAYS) {
      throw new BadRequestException(`Date range exceeds ${MAX_DAYS} days`);
    }

    const provider = options.provider?.trim().toLowerCase();
    const targetLanguage = options.targetLanguage?.trim().toLowerCase();

    const whereClauses: Prisma.Sql[] = [
      Prisma.sql`\`orgId\` = ${normalizedOrgId}`,
      Prisma.sql`\`date\` >= ${from}`,
      Prisma.sql`\`date\` <= ${to}`
    ];
    if (provider) {
      whereClauses.push(Prisma.sql`\`provider\` = ${provider}`);
    }
    if (targetLanguage) {
      whereClauses.push(Prisma.sql`\`targetLanguage\` = ${targetLanguage}`);
    }

    try {
      const whereSql = whereClauses.reduce((combined, clause, index) => {
        if (index === 0) {
          return clause;
        }
        return Prisma.sql`${combined} AND ${clause}`;
      });

      const rowsRaw = await this.prisma.$queryRaw<RssTranslationMetricsQueryRawRow[]>(
        Prisma.sql`
          SELECT
            \`date\`,
            \`provider\`,
            \`targetLanguage\`,
            \`requestCount\`,
            \`itemCount\`,
            \`textCount\`,
            \`cacheHitCount\`,
            \`cacheMissCount\`,
            \`translatedCount\`,
            \`failureCount\`,
            \`skipTooLongCount\`,
            \`totalLatencyMs\`,
            \`maxLatencyMs\`
          FROM \`RssTranslationMetricsDaily\`
          WHERE ${whereSql}
          ORDER BY \`date\` ASC, \`provider\` ASC, \`targetLanguage\` ASC
        `
      );

      const rows: RssTranslationMetricsDailyRow[] = rowsRaw.map((row) => {
        const requestCount = toSafeInt(row.requestCount);
        const cacheHitCount = toSafeInt(row.cacheHitCount);
        const cacheMissCount = toSafeInt(row.cacheMissCount);
        const failureCount = toSafeInt(row.failureCount);
        const cacheTotal = cacheHitCount + cacheMissCount;
        return {
          date:
            row.date instanceof Date
              ? formatUtcDate(row.date)
              : String(row.date).slice(0, 10),
          provider: String(row.provider),
          targetLanguage: String(row.targetLanguage),
          requestCount,
          itemCount: toSafeInt(row.itemCount),
          textCount: toSafeInt(row.textCount),
          cacheHitCount,
          cacheMissCount,
          translatedCount: toSafeInt(row.translatedCount),
          failureCount,
          skipTooLongCount: toSafeInt(row.skipTooLongCount),
          totalLatencyMs: toSafeInt(row.totalLatencyMs),
          maxLatencyMs: toSafeInt(row.maxLatencyMs),
          avgLatencyMs:
            requestCount > 0 ? Math.round(toSafeInt(row.totalLatencyMs) / requestCount) : 0,
          cacheHitRate: cacheTotal > 0 ? cacheHitCount / cacheTotal : 0,
          failureRate: requestCount > 0 ? failureCount / requestCount : 0
        };
      });

      const summary = rows.reduce<RssTranslationMetricsSummary>(
        (acc, row) => {
          acc.requestCount += row.requestCount;
          acc.itemCount += row.itemCount;
          acc.textCount += row.textCount;
          acc.cacheHitCount += row.cacheHitCount;
          acc.cacheMissCount += row.cacheMissCount;
          acc.translatedCount += row.translatedCount;
          acc.failureCount += row.failureCount;
          acc.skipTooLongCount += row.skipTooLongCount;
          acc.totalLatencyMs += row.totalLatencyMs;
          acc.maxLatencyMs = Math.max(acc.maxLatencyMs, row.maxLatencyMs);
          return acc;
        },
        {
          requestCount: 0,
          itemCount: 0,
          textCount: 0,
          cacheHitCount: 0,
          cacheMissCount: 0,
          translatedCount: 0,
          failureCount: 0,
          skipTooLongCount: 0,
          totalLatencyMs: 0,
          maxLatencyMs: 0,
          avgLatencyMs: 0,
          cacheHitRate: 0,
          failureRate: 0
        }
      );

      const cacheTotal = summary.cacheHitCount + summary.cacheMissCount;
      summary.avgLatencyMs =
        summary.requestCount > 0
          ? Math.round(summary.totalLatencyMs / summary.requestCount)
          : 0;
      summary.cacheHitRate = cacheTotal > 0 ? summary.cacheHitCount / cacheTotal : 0;
      summary.failureRate =
        summary.requestCount > 0 ? summary.failureCount / summary.requestCount : 0;

      return {
        from: formatUtcDate(from),
        to: formatUtcDate(to),
        rows,
        summary
      };
    } catch (error) {
      if (isPrismaMissingTableError(error)) {
        return {
          from: formatUtcDate(from),
          to: formatUtcDate(to),
          rows: [],
          summary: {
            requestCount: 0,
            itemCount: 0,
            textCount: 0,
            cacheHitCount: 0,
            cacheMissCount: 0,
            translatedCount: 0,
            failureCount: 0,
            skipTooLongCount: 0,
            totalLatencyMs: 0,
            maxLatencyMs: 0,
            avgLatencyMs: 0,
            cacheHitRate: 0,
            failureRate: 0
          }
        };
      }
      throw error;
    }
  }
}
