import { Injectable } from "@nestjs/common";

import { EnvService } from "../../config/config.service";
import type {
  SituationMonitorFedIndicator,
  SituationMonitorFedSnapshot,
  SituationMonitorMarketItem,
  SituationMonitorMarketsSnapshot,
  SituationMonitorMoneyPrinter,
} from "../situation-monitor.types";

const FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote";

// Major-market proxies: indices via ETFs, sectors via sector SPDRs, and
// commodity exposure via commodity ETFs (Finnhub quote covers equities).
const MARKET_INDEXES = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "NASDAQ 100" },
  { symbol: "DIA", name: "Dow 30" },
  { symbol: "IWM", name: "Russell 2000" },
] as const;

const MARKET_SECTORS = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLV", name: "Healthcare" },
  { symbol: "XLI", name: "Industrials" },
  { symbol: "XLY", name: "Consumer Disc." },
] as const;

const MARKET_COMMODITIES = [
  { symbol: "GLD", name: "Gold" },
  { symbol: "SLV", name: "Silver" },
  { symbol: "USO", name: "Crude Oil" },
  { symbol: "DBA", name: "Agriculture" },
] as const;

const VIX_SYMBOL = "VIXY" as const;

const FRED_SERIES: {
  seriesId: string;
  name: string;
  unit: string;
}[] = [
  { seriesId: "DFF", name: "Federal Funds Rate", unit: "%" },
  { seriesId: "T10Y2Y", name: "10Y-2Y Spread", unit: "%" },
  { seriesId: "T10YIE", name: "10Y Breakeven Inflation", unit: "%" },
  { seriesId: "DTB3", name: "3-Month T-Bill", unit: "%" },
  { seriesId: "WM2NS", name: "M2 Money Supply", unit: "$B" },
];

const FRED_OBSERVATIONS_URL =
  "https://api.stlouisfed.org/fred/series/observations";

const REQUEST_TIMEOUT_MS = 12_000;

@Injectable()
export class FinancialMainlineSnapshotService {
  constructor(private readonly env: EnvService) {}

  async getMarketsSnapshot(): Promise<SituationMonitorMarketsSnapshot> {
    const apiKey = this.finnhubApiKey;
    if (!apiKey) {
      return {
        hasFinnhubApiKey: false,
        indices: [],
        sectors: [],
        commodities: [],
        vix: null,
      };
    }

    const groups = [
      { type: "index" as const, entries: MARKET_INDEXES },
      { type: "sector" as const, entries: MARKET_SECTORS },
      { type: "commodity" as const, entries: MARKET_COMMODITIES },
    ];

    const results = await Promise.allSettled(
      groups.flatMap((group) =>
        group.entries.map((entry) =>
          this.fetchQuote(apiKey, entry.symbol).then((quote) => ({
            ...quote,
            ...entry,
            type: group.type,
          })),
        ),
      ),
    );

    const byType = { index: [] as SituationMonitorMarketItem[], sector: [] as SituationMonitorMarketItem[], commodity: [] as SituationMonitorMarketItem[] };
    let vix: SituationMonitorMarketItem | null = null;
    let failureCount = 0;

    for (const result of results) {
      if (result.status === "rejected") {
        failureCount += 1;
        continue;
      }
      const item = result.value;
      byType[item.type].push(item);
    }

    // Volatility proxy (VIXY ETF) is fetched separately from the typed groups.
    const vixResult = await Promise.allSettled([
      this.fetchQuote(apiKey, VIX_SYMBOL),
    ]);
    if (vixResult[0]?.status === "fulfilled") {
      vix = {
        ...vixResult[0].value,
        symbol: "VIX",
        name: "VIX Volatility",
        type: "index",
      };
    } else {
      failureCount += 1;
    }

    return {
      hasFinnhubApiKey: true,
      indices: byType.index,
      sectors: byType.sector,
      commodities: byType.commodity,
      vix,
      ...(failureCount > 0
        ? { error: `${failureCount} quote(s) failed to load` }
        : {}),
    };
  }

  async getFedSnapshot(): Promise<SituationMonitorFedSnapshot> {
    const apiKey = this.fredApiKey;
    if (!apiKey) {
      return {
        hasFredApiKey: false,
        indicators: [],
        moneyPrinter: null,
        news: [],
      };
    }

    const results = await Promise.allSettled(
      FRED_SERIES.map((series) =>
        this.fetchFredSeries(apiKey, series).then((observation) => ({
          series,
          observation,
        })),
      ),
    );

    const indicators: SituationMonitorFedIndicator[] = [];
    let m2Observation: { value: number; previous: number | null } | null = null;
    let failureCount = 0;

    for (const result of results) {
      if (result.status === "rejected") {
        failureCount += 1;
        continue;
      }
      const { series, observation } = result.value;
      if (series.seriesId === "WM2NS") {
        m2Observation = observation;
      }
      indicators.push({
        seriesId: series.seriesId,
        name: series.name,
        value: observation.value,
        change: observation.previous,
        unit: series.unit,
      });
    }

    return {
      hasFredApiKey: true,
      indicators,
      moneyPrinter: this.buildMoneyPrinter(m2Observation),
      news: [],
      ...(failureCount > 0
        ? { error: `${failureCount} FRED series failed to load` }
        : {}),
    };
  }

  private get finnhubApiKey(): string | undefined {
    return this.env.get<string | undefined>("FINNHUB_API_KEY", {
      infer: true,
    });
  }

  private get fredApiKey(): string | undefined {
    return this.env.get<string | undefined>("FRED_API_KEY", {
      infer: true,
    });
  }

  private async fetchQuote(
    apiKey: string,
    symbol: string,
  ): Promise<{ price: number; change: number; changePercent: number }> {
    const params = new URLSearchParams({ symbol, token: apiKey });
    const response = await fetch(
      `${FINNHUB_QUOTE_URL}?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Finnhub quote HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      c?: unknown;
      d?: unknown;
      dp?: unknown;
    };
    const price = Number(payload.c);
    if (!Number.isFinite(price)) {
      throw new Error(`Finnhub quote missing close for ${symbol}`);
    }
    const change = Number(payload.d);
    const changePercent = Number(payload.dp);
    return {
      price,
      change: Number.isFinite(change) ? change : 0,
      changePercent: Number.isFinite(changePercent) ? changePercent : 0,
    };
  }

  private async fetchFredSeries(
    apiKey: string,
    series: { seriesId: string },
  ): Promise<{ value: number; previous: number | null }> {
    const params = new URLSearchParams({
      series_id: series.seriesId,
      api_key: apiKey,
      file_type: "json",
      sort_order: "desc",
      limit: "3",
    });
    const response = await fetch(
      `${FRED_OBSERVATIONS_URL}?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`FRED HTTP ${response.status} for ${series.seriesId}`);
    }
    const payload = (await response.json()) as {
      observations?: { value?: unknown }[];
    };
    const observations = (payload.observations ?? []).filter(
      (observation) =>
        typeof observation.value === "string" &&
        observation.value.trim().length > 0 &&
        observation.value.trim() !== ".",
    );
    const latest = observations[0];
    const previous = observations[1];
    if (!latest) {
      throw new Error(`FRED series ${series.seriesId} has no observations`);
    }
    return {
      value: Number(latest.value),
      previous:
        previous && Number.isFinite(Number(previous.value))
          ? Number(previous.value)
          : null,
    };
  }

  private buildMoneyPrinter(
    observation: { value: number; previous: number | null } | null,
  ): SituationMonitorMoneyPrinter | null {
    if (!observation || !Number.isFinite(observation.value)) {
      return null;
    }
    const valueTrillions = observation.value / 1_000;
    const changeTrillions =
      observation.previous !== null
        ? (observation.value - observation.previous) / 1_000
        : 0;
    return {
      valueTrillions: round2(valueTrillions),
      changeTrillions: round2(changeTrillions),
      changePercent:
        observation.previous !== null && observation.previous !== 0
          ? round2(
              ((observation.value - observation.previous) /
                observation.previous) *
                100,
            )
          : 0,
      // Percent of an arbitrary recent peak; FRED WM2NS caps the series so
      // this is a stable approximation of "how close to the top we are".
      percentOfMax: round2((valueTrillions / 22.5) * 100),
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
