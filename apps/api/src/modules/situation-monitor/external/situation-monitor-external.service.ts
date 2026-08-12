import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { fetchWithIpv4Fallback } from "../../../common/http/fetch-with-ipv4-fallback";
import { EnvService } from "../../config/config.service";
import type { SituationMonitorCategory } from "../situation-monitor.constants";
import type {
  SituationMonitorCryptoItem,
  SituationMonitorFedNewsItem,
  SituationMonitorHeadline,
} from "../situation-monitor.types";

export interface SituationMonitorExternalWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  detail?: string;
}

/**
 * Shape consumed by the situation-monitor core when appending GDELT headlines
 * into per-category buckets. Fields are picked from the full headline so the
 * spread in tryAppendGdeltHeadline produces a complete SituationMonitorHeadline.
 */
export type SituationMonitorGdeltHeadlineCandidate = Pick<
  SituationMonitorHeadline,
  "id" | "title" | "link" | "source" | "timestamp" | "origin" | "isAlert"
> & { category?: SituationMonitorCategory };

const logger = createLogger({ name: "situation-monitor-external" });

const GDELT_DOC2_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_REQUEST_TIMEOUT_MS = 20_000;
const GDELT_MAX_RECORDS = 25;

const COINGECKO_SIMPLE_URL =
  "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_IDS =
  "bitcoin,ethereum,binancecoin,solana,xrp,cardano,dogecoin,toncoin";

// Broad GDELT DOC 2.0 free-text queries per situation-monitor category.
// GDELT's own relevance ranking does the heavy lifting; these are just topic
// signals. Deliberately not theme-based to avoid coupling to GDELT theme
// taxonomy changes.
const CATEGORY_QUERIES: Record<SituationMonitorCategory, string> = {
  politics:
    '"politics" OR "election" OR "diplomacy" OR "government" OR "parliament"',
  tech: '"technology" OR "cyber" OR "semiconductor" OR "big tech" OR "startup"',
  finance:
    '"finance" OR "economy" OR "markets" OR "trade" OR "inflation" OR "central bank"',
  gov: '"government" OR "policy" OR "regulation" OR "legislation" OR "cabinet"',
  ai: '"artificial intelligence" OR "machine learning" OR "generative ai" OR "llm"',
  intel: '"intelligence" OR "espionage" OR "military" OR "defense" OR "nato"',
};

@Injectable()
export class SituationMonitorExternalService {
  constructor(private readonly env: EnvService) {}

  isGdeltEnabled(): boolean {
    return (
      this.env.get<boolean>("SITUATION_MONITOR_GDELT_ENABLED", {
        infer: true,
      }) ?? true
    );
  }

  async fetchGdeltCategoryHeadlines(
    category: SituationMonitorCategory,
    limit: number,
    options?: { bypassCache?: boolean; timeoutMs?: number },
  ): Promise<{
    headlines: SituationMonitorHeadline[];
    warning?: SituationMonitorExternalWarning;
  }> {
    const maxRecords = Math.max(1, Math.min(Math.round(limit), GDELT_MAX_RECORDS));
    const params = new URLSearchParams({
      query: CATEGORY_QUERIES[category],
      mode: "artlist",
      maxrecords: String(maxRecords),
      timespan: "24h",
      format: "json",
      lang: "eng",
    });
    const url = `${GDELT_DOC2_URL}?${params.toString()}`;

    try {
      const response = await fetchWithIpv4Fallback(
        url,
        {
          headers: { Accept: "application/json" },
          ...(options?.bypassCache ? { cache: "no-store" as const } : {}),
        },
        {
          timeoutMs: options?.timeoutMs ?? GDELT_REQUEST_TIMEOUT_MS,
        },
      );

      if (!response.ok) {
        if (response.status === 429) {
          return {
            headlines: [],
            warning: {
              code: "gdelt_rate_limited",
              severity: "warning",
              message: "GDELT is rate limiting requests",
              detail: `HTTP ${response.status}`,
            },
          };
        }
        return {
          headlines: [],
          warning: {
            code: "gdelt_http_error",
            severity: "warning",
            message: `GDELT request failed with HTTP ${response.status}`,
          },
        };
      }

      const payload = (await response.json()) as {
        articles?: {
          url?: unknown;
          title?: unknown;
          source?: unknown;
          domain?: unknown;
          seendate?: unknown;
        }[];
      };

      const headlines: SituationMonitorHeadline[] = [];
      const seen = new Set<string>();
      for (const article of payload.articles ?? []) {
        const title =
          typeof article.title === "string" ? article.title.trim() : "";
        const link =
          typeof article.url === "string" ? article.url.trim() : "";
        if (!title || !link || seen.has(link)) {
          continue;
        }
        seen.add(link);

        const rawSource = article.domain ?? article.source;
        const source =
          typeof rawSource === "string" && rawSource.trim().length > 0
            ? rawSource.trim()
            : "GDELT";
        headlines.push({
          id: `gdelt:${link}`,
          title,
          link,
          source,
          timestamp: this.parseGdeltSeenDate(article.seendate),
          category,
          origin: "gdelt",
          isAlert: false,
        });
        if (headlines.length >= maxRecords) {
          break;
        }
      }

      return {
        headlines,
        ...(headlines.length === 0
          ? {
              warning: {
                code: "gdelt_empty",
                severity: "info" as const,
                message: "GDELT returned no articles for this category",
              },
            }
          : {}),
      };
    } catch (error) {
      logger.warn({ error, category }, "GDELT category fetch failed");
      return {
        headlines: [],
        warning: {
          code: "gdelt_fetch_failed",
          severity: "warning",
          message: "GDELT request failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async getCryptoSnapshot(): Promise<SituationMonitorCryptoItem[]> {
    const params = new URLSearchParams({
      ids: COINGECKO_IDS,
      vs_currencies: "usd",
      include_24hr_change: "true",
    });
    const url = `${COINGECKO_SIMPLE_URL}?${params.toString()}`;

    try {
      const response = await fetchWithIpv4Fallback(url, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "CoinGecko snapshot request failed",
        );
        return [];
      }
      const payload = (await response.json()) as Record<
        string,
        { usd?: unknown; usd_24h_change?: unknown } | undefined
      >;

      const items: SituationMonitorCryptoItem[] = [];
      for (const [id, data] of Object.entries(payload)) {
        const price = Number(data?.usd);
        if (!Number.isFinite(price) || price <= 0) {
          continue;
        }
        const change = Number(data?.usd_24h_change);
        items.push({
          id,
          symbol: id.toUpperCase(),
          name: id,
          currentPriceUsd: price,
          change24hPercent: Number.isFinite(change) ? change : 0,
        });
      }
      return items;
    } catch (error) {
      logger.warn({ error }, "CoinGecko snapshot failed");
      return [];
    }
  }

  async getFedNews(): Promise<SituationMonitorFedNewsItem[]> {
    // There is no credential-free Fed news endpoint; callers already degrade
    // via Promise.allSettled, and the FRED-backed snapshot carries its own
    // news array when an API key is configured.
    return [];
  }

  private parseGdeltSeenDate(value: unknown): number {
    // GDELT seendate format: "20240812T143000Z" (UTC).
    if (typeof value === "string") {
      const match = value
        .trim()
        .match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
      if (match) {
        const [, year, month, day, hour, minute, second] = match;
        const date = new Date(
          Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
          ),
        );
        if (!Number.isNaN(date.getTime())) {
          return date.getTime();
        }
      }
    }
    return Date.now();
  }
}
