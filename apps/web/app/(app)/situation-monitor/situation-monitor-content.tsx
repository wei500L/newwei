"use client";

import { FileSearchOutlined, InfoCircleOutlined, SettingOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Divider, Drawer, Grid, List, Popover, Progress, Row, Select, Space, Switch, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { Layout } from "react-grid-layout";
import { useTranslation } from "react-i18next";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { WarMap } from "@/app/(app)/dashboard/charts/war-map";
import { ArticlePublishedTime } from "@/components/article-published-time";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import {
  SITUATION_MONITOR_PANELS,
  SITUATION_MONITOR_PRESETS,
  type SituationMonitorPanelId,
  useSituationMonitorLayoutStore
} from "@/store/situation-monitor-layout";
import { useSituationMonitorMonitorsStore, type SituationMonitorMonitorMatch } from "@/store/situation-monitor-monitors";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";
import { useUserUiSyncStatusStore } from "@/store/user-ui-sync-status";

import { SituationMonitorLiveNewsPanel } from "./components/situation-monitor-live-news-panel";
import { SituationMonitorLiveWebcamsPanel } from "./components/situation-monitor-live-webcams-panel";
import { useSituationMonitorStream } from "./hooks/use-situation-monitor-stream";
import { SituationMonitorMonitorsPanel } from "./situation-monitor-monitors-panel";
import type {
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationTelegramFeedResponse,
} from "./types/situation-monitor-signals";

type GridLayoutComponent = ComponentType<Record<string, unknown>>;

const ResponsiveGridLayout = dynamic(
  () =>
    import("react-grid-layout").then((mod) => {
      const responsive =
        mod.Responsive ??
        (typeof mod.default === "function" || typeof mod.default === "object"
          ? (mod.default as { Responsive?: unknown }).Responsive
          : undefined);

      const widthProvider =
        mod.WidthProvider ??
        (typeof mod.default === "function" || typeof mod.default === "object"
          ? (mod.default as { WidthProvider?: unknown }).WidthProvider
          : undefined);

      if (typeof responsive !== "function" || typeof widthProvider !== "function") {
        throw new Error("react-grid-layout exports are not available");
      }

      return (widthProvider as (component: GridLayoutComponent) => GridLayoutComponent)(responsive as GridLayoutComponent);
    }),
  {
    ssr: false,
  },
);

const GRID_BREAKPOINTS = { lg: 992, md: 768, sm: 576, xs: 480, xxs: 0 } as const;

const GRID_COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 } as const;

const MD_TWO_COLUMN_PANELS = new Set<string>([
  "feeds-politics",
  "feeds-tech",
  "feeds-finance",
  "feeds-gov",
  "feeds-ai",
  "feeds-intel",
  "situation-venezuela",
  "situation-greenland",
  "situation-iran",
]);

interface HeadlineRef {
  title: string;
  titleZh?: string;
  link: string;
  source: string;
  itemMetaId?: string;
}

interface SignalFeedback {
  falsePositive: number;
  falseNegative: number;
}

interface SignalLearning {
  boostedTokens: string[];
  blockedTokens: string[];
  suppressedCount: number;
}

interface EmergingPattern {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  count: number;
  level: "high" | "elevated" | "emerging";
  sources: string[];
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

interface MomentumSignal {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  current: number;
  delta: number;
  momentum: "surging" | "rising" | "stable";
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

interface PredictiveSignal {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  score: number;
  confidence: number;
  prediction: string;
  predictionZh?: string;
  level: "high" | "medium" | "low";
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

interface CrossSourceCorrelation {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  sourceCount: number;
  sources: string[];
  level: "high" | "elevated" | "emerging";
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

interface CorrelationResults {
  emergingPatterns: EmergingPattern[];
  momentumSignals: MomentumSignal[];
  crossSourceCorrelations: CrossSourceCorrelation[];
  predictiveSignals: PredictiveSignal[];
}

type SituationMonitorCategory = "politics" | "tech" | "finance" | "gov" | "ai" | "intel";

interface SituationMonitorHeadline {
  id: string;
  itemMetaId?: string;
  title: string;
  titleZh?: string;
  link: string;
  source: string;
  timestamp: number;
  category: SituationMonitorCategory;
  origin: "items" | "gdelt";
  isAlert: boolean;
  alertKeyword?: string;
  summary?: string;
  summaryZh?: string;
  keyPoints?: string[];
  keyPointsZh?: string[];
  topics?: string[];
}

interface SituationMonitorAlertHeadline extends SituationMonitorHeadline {
  severity: "critical" | "elevated";
}

interface SituationMonitorWorldLeader {
  id: string;
  name: string;
  title: string;
  country: string;
  flag?: string;
  since?: string;
  party?: string;
  focus?: string[];
  matchCount: number;
  headlines: { title: string; titleZh?: string; link: string; source: string; timestamp: number }[];
}

interface SituationMonitorSituationPanel {
  id: "venezuela" | "greenland" | "iran";
  title: string;
  titleZh?: string;
  subtitle: string;
  subtitleZh?: string;
  level: "monitoring" | "elevated" | "critical";
  status: "MONITORING" | "ELEVATED" | "CRITICAL";
  headlines: { title: string; titleZh?: string; link: string; source: string; timestamp: number }[];
}

interface SituationMonitorMarketItem {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  type: "index" | "sector" | "commodity";
}

interface SituationMonitorMarketsSnapshot {
  hasFinnhubApiKey: boolean;
  indices: SituationMonitorMarketItem[];
  sectors: SituationMonitorMarketItem[];
  commodities: SituationMonitorMarketItem[];
  vix: SituationMonitorMarketItem | null;
  error?: string;
}

interface SituationMonitorCryptoItem {
  id: string;
  symbol: string;
  name: string;
  currentPriceUsd: number;
  change24hPercent: number;
}

interface SituationMonitorFedIndicator {
  seriesId: string;
  name: string;
  value: number | null;
  change: number | null;
  unit: string;
}

interface SituationMonitorMoneyPrinter {
  valueTrillions: number;
  changeTrillions: number;
  changePercent: number;
  percentOfMax: number;
}

interface SituationMonitorFedNewsItem {
  id: string;
  title: string;
  titleZh?: string;
  link: string;
  description: string;
  descriptionZh?: string;
  pubDate: string;
  timestamp: number;
  type: "monetary" | "powell" | "speech" | "testimony" | "announcement";
  typeLabel: string;
  typeLabelZh?: string;
  isPowellRelated: boolean;
  hasVideo: boolean;
}

interface SituationMonitorFedSnapshot {
  hasFredApiKey: boolean;
  indicators: SituationMonitorFedIndicator[];
  moneyPrinter: SituationMonitorMoneyPrinter | null;
  news: SituationMonitorFedNewsItem[];
  error?: string;
}

interface CrossSourceRadarCluster {
  id: string;
  itemCount: number;
  sources: string[];
  samples: { title: string; titleZh?: string; link: string; source: string; timestamp: number; itemMetaId?: string }[];
}

interface CrossSourceRadar {
  consistency: number;
  divergence: number;
  clusterCount: number;
  clusters: CrossSourceRadarCluster[];
  outlierSources: string[];
}

interface FringeMainstreamPathStep {
  tier: "fringe" | "alternative" | "mainstream" | "unknown";
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  sources: string[];
}

interface FringeMainstreamPath {
  steps: FringeMainstreamPathStep[];
  lagToMainstreamMs?: number;
}

interface CitationLink {
  from: string;
  to: string;
  weight: number;
}

interface CitationChain {
  nodes: string[];
  links: CitationLink[];
  topCited: { source: string; weight: number }[];
  citedByCount: number;
}

interface CredibilityAssessment {
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
  components: {
    sourceReliability: number;
    corroboration: number;
    citationSupport: number;
    divergence: number;
    feedbackPenalty: number;
  };
}

interface NarrativePropagationModel {
  crossSourceRadar: CrossSourceRadar;
  fringeToMainstreamPath: FringeMainstreamPath;
  credibility: CredibilityAssessment;
  citationChain: CitationChain;
}

interface NarrativeData {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  severity: "watch" | "emerging" | "spreading" | "disinfo";
  count: number;
  fringeCount: number;
  alternativeCount: number;
  mainstreamCount: number;
  sources: string[];
  headlines: { title: string; titleZh?: string; link: string; source: string; timestamp: number; itemMetaId?: string }[];
  keywords: string[];
  feedback?: { falsePositive: number; falseNegative: number };
  model?: NarrativePropagationModel;
  learning?: { boostedTokens: string[]; blockedTokens: string[]; suppressedCount: number };
}

interface FringeToMainstream extends NarrativeData {
  status: "crossing";
  crossoverLevel: number;
}

interface EmergingFringe extends NarrativeData {
  status: "emerging" | "spreading" | "viral";
}

interface NarrativeResults {
  emergingFringe: EmergingFringe[];
  fringeToMainstream: FringeToMainstream[];
  disinfoSignals: NarrativeData[];
  narrativeWatch: NarrativeData[];
}

interface MainCharacterEntry {
  name: string;
  count: number;
  rank: number;
}

interface SituationMonitorInsightsResponse {
  generatedAt: string;
  windowHours: number;
  maxItems: number;
  analyzedItems: number;
  translation?: { target: "zh-CN"; applied: boolean; error?: string };
  headlines?: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  alerts?: SituationMonitorAlertHeadline[];
  leaders?: SituationMonitorWorldLeader[];
  situations?: SituationMonitorSituationPanel[];
  markets?: SituationMonitorMarketsSnapshot;
  crypto?: SituationMonitorCryptoItem[];
  fed?: SituationMonitorFedSnapshot;
  correlation?: CorrelationResults | null;
  correlationSummary?: { totalSignals: number; status: string; statusZh?: string };
  narrative?: NarrativeResults | null;
  narrativeSummary?: { total: number; status: string; statusZh?: string };
  mainCharacter?: { characters: MainCharacterEntry[]; topCharacter: MainCharacterEntry | null };
  mainCharacterSummary?: { name: string; count: number; status: string; statusZh?: string };
}

function mergeTranslationStatus(
  base: SituationMonitorInsightsResponse["translation"],
  next: SituationMonitorInsightsResponse["translation"],
): SituationMonitorInsightsResponse["translation"] {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  if (base.target !== next.target) {
    return base;
  }
  if (base.applied && next.applied) {
    return base;
  }
  const error = [base.error, next.error].filter(Boolean).join(" | ");
  return {
    target: base.target,
    applied: false,
    ...(error ? { error } : {}),
  };
}

function toTagColor(level: string) {
  switch (level.toLowerCase()) {
    case "high":
      return "red";
    case "elevated":
      return "orange";
    case "emerging":
      return "blue";
    default:
      return "default";
  }
}

function toCredibilityColor(level: string) {
  switch (level.toLowerCase()) {
    case "high":
      return "green";
    case "medium":
      return "orange";
    case "low":
      return "red";
    default:
      return "default";
  }
}

function formatUsd(value: number, locale: string) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (Math.abs(value) >= 1_000_000_000) {
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  }
  if (Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  }
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatDurationMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function mergePanelLayouts(existing: Layout[], updates: Layout[]): Layout[] {
  const updatesById = new Map(updates.map((item) => [item.i, item]));
  const merged = existing.map((item) => {
    const update = updatesById.get(item.i);
    if (!update) {
      return item;
    }
    updatesById.delete(item.i);
    return {
      ...item,
      ...update,
      i: item.i,
      static: item.static ?? update.static,
    };
  });

  for (const update of updatesById.values()) {
    merged.push(update);
  }

  return merged;
}

function clampColsConstraint(value: unknown, cols: number): number | undefined {
  return typeof value === "number" ? Math.min(value, cols) : undefined;
}

function desiredPanelWidth(panelId: string, cols: number): number {
  if (cols <= 6) {
    return cols;
  }
  if (cols === 10 && MD_TWO_COLUMN_PANELS.has(panelId)) {
    return 5;
  }
  return cols;
}

function buildPackedResponsiveLayout(base: Layout[], cols: number): Layout[] {
  const ordered = base
    .slice()
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;

  return ordered.map((item) => {
    const w = Math.min(cols, desiredPanelWidth(item.i, cols));
    const h = typeof item.h === "number" && item.h > 0 ? item.h : 6;

    if (cursorX + w > cols) {
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }

    const next: Layout = {
      ...item,
      x: cursorX,
      y: cursorY,
      w,
      h,
      minW: clampColsConstraint(item.minW, cols),
      maxW: clampColsConstraint(item.maxW, cols),
      i: item.i,
    };

    cursorX += w;
    rowH = Math.max(rowH, h);

    return next;
  });
}

function projectLayoutToLg(nextLayout: Layout[], fromCols: number): Layout[] {
  const lgCols = GRID_COLS.lg;
  if (fromCols >= lgCols) {
    return nextLayout.map((item) => ({
      i: item.i,
      x: typeof item.x === "number" ? item.x : 0,
      y: typeof item.y === "number" ? item.y : 0,
      w: typeof item.w === "number" ? item.w : 1,
      h: typeof item.h === "number" ? item.h : 1,
    }));
  }

  const scale = lgCols / fromCols;
  return nextLayout.map((item) => {
    const rawW = Math.max(1, Math.round((typeof item.w === "number" ? item.w : 1) * scale));
    const w = Math.min(lgCols, rawW);
    const rawX = Math.max(0, Math.round((typeof item.x === "number" ? item.x : 0) * scale));
    const x = Math.min(Math.max(0, lgCols - w), rawX);
    return {
      i: item.i,
      x,
      y: typeof item.y === "number" ? item.y : 0,
      w,
      h: typeof item.h === "number" ? item.h : 1,
    };
  });
}

function spansOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function stretchCorrelationToMonitorArea(layout: Layout[]): Layout[] {
  const correlation = layout.find((item) => item.i === "correlation");
  const monitors = layout.find((item) => item.i === "monitors");
  if (!correlation || !monitors) {
    return layout;
  }

  const correlationX = typeof correlation.x === "number" ? correlation.x : 0;
  const correlationY = typeof correlation.y === "number" ? correlation.y : 0;
  const correlationW = typeof correlation.w === "number" ? correlation.w : 0;
  const correlationH = typeof correlation.h === "number" ? correlation.h : 0;

  const monitorsX = typeof monitors.x === "number" ? monitors.x : 0;
  const monitorsY = typeof monitors.y === "number" ? monitors.y : 0;
  const monitorsW = typeof monitors.w === "number" ? monitors.w : 0;

  if (!spansOverlap(correlationX, correlationX + correlationW, monitorsX, monitorsX + monitorsW)) {
    return layout;
  }
  if (monitorsY <= correlationY) {
    return layout;
  }

  let boundaryY = monitorsY;
  for (const item of layout) {
    if (item.i === "correlation" || item.i === "monitors") {
      continue;
    }
    const x = typeof item.x === "number" ? item.x : 0;
    const y = typeof item.y === "number" ? item.y : 0;
    const w = typeof item.w === "number" ? item.w : 0;
    if (y <= correlationY) {
      continue;
    }
    if (!spansOverlap(correlationX, correlationX + correlationW, x, x + w)) {
      continue;
    }
    boundaryY = Math.min(boundaryY, y);
  }

  const desiredHeight = Math.max(1, boundaryY - correlationY);
  if (!Number.isFinite(desiredHeight) || desiredHeight <= correlationH) {
    return layout;
  }

  return layout.map((item) => (item.i === "correlation" ? { ...item, h: desiredHeight } : item));
}

function isVisibilityMatchingPreset(
  visibility: Record<SituationMonitorPanelId, boolean>,
  panels: SituationMonitorPanelId[]
): boolean {
  const enabled = new Set<SituationMonitorPanelId>(panels);
  for (const [key, value] of Object.entries(visibility)) {
    const id = key as SituationMonitorPanelId;
    if (value !== enabled.has(id)) {
      return false;
    }
  }
  return true;
}

export function SituationMonitorContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const screens = Grid.useBreakpoint();
  const uiSync = useUserUiSyncStatusStore((state) => state.sections["situation-monitor"]);
  const requestUiSyncReload = useUserUiSyncStatusStore((state) => state.requestReload);

  const windowHours = useSituationMonitorSettingsStore((state) => state.windowHours);
  const setWindowHours = useSituationMonitorSettingsStore((state) => state.setWindowHours);
  const scope = useSituationMonitorSettingsStore((state) => state.scope);
  const setScope = useSituationMonitorSettingsStore((state) => state.setScope);
  const autoRefresh = useSituationMonitorSettingsStore((state) => state.autoRefresh);
  const setAutoRefresh = useSituationMonitorSettingsStore((state) => state.setAutoRefresh);
  const translateToZh = useSituationMonitorSettingsStore((state) => state.translateToZh);
  const setTranslateToZh = useSituationMonitorSettingsStore((state) => state.setTranslateToZh);
  const [refreshStage, setRefreshStage] = useState<"idle" | "core" | "external">("idle");
  const [error, setError] = useState<string | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [data, setData] = useState<SituationMonitorInsightsResponse | null>(null);
  const [telegramFeed, setTelegramFeed] = useState<SituationTelegramFeedResponse | null>(null);
  const [orefAlerts, setOrefAlerts] = useState<SituationOrefAlertsResponse | null>(null);
  const [orefHistory, setOrefHistory] = useState<SituationOrefHistoryResponse | null>(null);
  const [signalsLoading, setSignalsLoading] = useState<{ telegram: boolean; oref: boolean }>({
    telegram: false,
    oref: false,
  });
  const [feedbackDrawerOpen, setFeedbackDrawerOpen] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [signalCatalog, setSignalCatalog] = useState<null | {
    narratives: { id: string; name: string; category: string; severity: string }[];
    correlations: { id: string; name: string; category: string }[];
  }>(null);
  const [missedSignalType, setMissedSignalType] = useState<"narrative" | "correlation">("narrative");
  const [missedSignalId, setMissedSignalId] = useState<string>("");
  const [missedHeadlineId, setMissedHeadlineId] = useState<string>("");
  const refreshIdRef = useRef(0);
  const loading = refreshStage !== "idle";

  const monitors = useSituationMonitorMonitorsStore((state) => state.monitors);
  const monitorMatches = useSituationMonitorMonitorsStore((state) => state.matches);
  const scanMonitors = useSituationMonitorMonitorsStore((state) => state.scan);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSignalCatalog = useCallback(async () => {
    if (!session?.accessToken || signalCatalog || catalogLoading) {
      return;
    }
    setCatalogLoading(true);
    try {
      const response = await apiClient.get("situation-monitor/catalog");
      setSignalCatalog(response.data ?? null);
    } catch (err) {
      captureClientError("Failed to load situation monitor catalog", err);
    } finally {
      setCatalogLoading(false);
    }
  }, [apiClient, catalogLoading, session?.accessToken, signalCatalog]);

  const loadTelegramFeed = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!session?.accessToken) {
        return;
      }

      const silent = options?.silent ?? false;
      if (!silent) {
        setSignalsLoading((prev) => ({ ...prev, telegram: true }));
      }

      try {
        const response = await apiClient.get<SituationTelegramFeedResponse>(
          "situation-monitor/telegram-feed",
          {
            params: { limit: 80 },
          },
        );
        setTelegramFeed(response.data ?? null);
      } catch (err) {
        captureClientError("Failed to load situation monitor telegram feed", err);
      } finally {
        if (!silent) {
          setSignalsLoading((prev) => ({ ...prev, telegram: false }));
        }
      }
    },
    [apiClient, session?.accessToken],
  );

  const loadOrefSignals = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!session?.accessToken) {
        return;
      }

      const silent = options?.silent ?? false;
      if (!silent) {
        setSignalsLoading((prev) => ({ ...prev, oref: true }));
      }

      try {
        const [alertsResponse, historyResponse] = await Promise.all([
          apiClient.get<SituationOrefAlertsResponse>("situation-monitor/oref-alerts"),
          apiClient.get<SituationOrefHistoryResponse>("situation-monitor/oref-history"),
        ]);

        setOrefAlerts(alertsResponse.data ?? null);
        setOrefHistory(historyResponse.data ?? null);
      } catch (err) {
        captureClientError("Failed to load situation monitor OREF signals", err);
      } finally {
        if (!silent) {
          setSignalsLoading((prev) => ({ ...prev, oref: false }));
        }
      }
    },
    [apiClient, session?.accessToken],
  );

  const load = useCallback(async (options?: { includeExternal?: boolean }) => {
    if (!session?.accessToken) {
      return;
    }
    const includeExternal = options?.includeExternal ?? true;
    const refreshId = (refreshIdRef.current += 1);
    setRefreshStage("core");
    setError(null);
    try {
      const coreResponse = await apiClient.get<SituationMonitorInsightsResponse>("situation-monitor/insights", {
        params: { windowHours, maxItems: 400, sections: "core", scope, translate: translateToZh ? "zh-CN" : undefined },
      });

      if (refreshIdRef.current !== refreshId) {
        return;
      }

      const coreData = coreResponse.data ?? null;
      if (coreData) {
        setData((prev) => {
          if (!prev) {
            return coreData;
          }
          return {
            ...prev,
            ...coreData,
            translation: coreData.translation,
          };
        });
      }

      if (!includeExternal) {
        return;
      }

      setRefreshStage("external");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (refreshIdRef.current !== refreshId) {
        return;
      }

      const externalResponse = await apiClient.get<SituationMonitorInsightsResponse>("situation-monitor/insights", {
        params: { windowHours, maxItems: 400, sections: "external", scope, translate: translateToZh ? "zh-CN" : undefined },
      });

      if (refreshIdRef.current !== refreshId) {
        return;
      }

      const externalData = externalResponse.data ?? null;
      if (externalData) {
        setData((prev) => {
          if (!prev) {
            return externalData;
          }

          const merged: SituationMonitorInsightsResponse = { ...prev };
          if (externalData.crypto !== undefined) {
            merged.crypto = externalData.crypto;
          }
          if (externalData.markets !== undefined) {
            merged.markets = externalData.markets;
          }
          if (externalData.fed !== undefined) {
            merged.fed = externalData.fed;
          }

          // External refresh always has `analyzedItems: 0`; keep core counters and window/maxItems.
          merged.windowHours = prev.windowHours;
          merged.maxItems = prev.maxItems;
          merged.analyzedItems = prev.analyzedItems;

          // Still surface the latest refresh timestamp so the header reflects the most recent load.
          if (externalData.generatedAt) {
            merged.generatedAt = externalData.generatedAt;
          }

          merged.translation = mergeTranslationStatus(prev.translation, externalData.translation);
          return merged;
        });
      }
    } catch (err) {
      captureClientError("Failed to load situation monitor insights", err);
      if (refreshIdRef.current === refreshId) {
        setError(err instanceof Error ? err.message : "Failed to load situation monitor insights.");
      }
    } finally {
      if (refreshIdRef.current === refreshId) {
        setRefreshStage("idle");
      }
    }
  }, [apiClient, scope, session?.accessToken, translateToZh, windowHours]);

  const submitSignalFeedback = useCallback(
    async (payload: {
      signalType: "narrative" | "correlation";
      signalId: string;
      label: "false_positive" | "false_negative";
      item?: { itemMetaId?: string; title?: string; source?: string; link?: string } | null;
    }) => {
      if (!session?.accessToken) {
        return;
      }
      try {
        setFeedbackNotice(null);
        await apiClient.post("situation-monitor/feedback", {
          signalType: payload.signalType,
          signalId: payload.signalId,
          label: payload.label,
          itemMetaId: payload.item?.itemMetaId,
          itemTitle: payload.item?.title,
          itemSource: payload.item?.source,
          itemLink: payload.item?.link,
        });
        setFeedbackNotice({
          type: "success",
          message:
            payload.label === "false_positive"
              ? t("common.feedbackSaved", { defaultValue: "Marked as false positive." })
              : t("common.feedbackSaved", { defaultValue: "Marked as missed detection." }),
        });
        void load({ includeExternal: false });
        setTimeout(() => setFeedbackNotice(null), 3500);
      } catch (err) {
        captureClientError("Failed to submit situation monitor feedback", err);
        setFeedbackNotice({
          type: "error",
          message: t("common.feedbackFailed", { defaultValue: "Failed to submit feedback." }),
        });
        setTimeout(() => setFeedbackNotice(null), 4000);
      }
    },
    [apiClient, load, session?.accessToken, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadTelegramFeed();
    void loadOrefSignals();
  }, [loadOrefSignals, loadTelegramFeed]);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    if (!session?.accessToken) {
      return;
    }
    const timer = setInterval(() => {
      void loadTelegramFeed({ silent: true });
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadTelegramFeed, session?.accessToken]);

  useEffect(() => {
    if (!session?.accessToken) {
      return;
    }
    const timer = setInterval(() => {
      void loadOrefSignals({ silent: true });
    }, 120_000);
    return () => clearInterval(timer);
  }, [loadOrefSignals, session?.accessToken]);

  const handleRealtimeTelegramUpdate = useCallback(() => {
    void loadTelegramFeed({ silent: true });
  }, [loadTelegramFeed]);

  const handleRealtimeOrefUpdate = useCallback(() => {
    void loadOrefSignals({ silent: true });
  }, [loadOrefSignals]);

  const realtimeState = useSituationMonitorStream({
    onTelegramUpdate: handleRealtimeTelegramUpdate,
    onOrefUpdate: handleRealtimeOrefUpdate,
  });

  const monitorScanItems: SituationMonitorMonitorMatch["item"][] = useMemo(() => {
    const items: SituationMonitorMonitorMatch["item"][] = [];
    const seen = new Set<string>();

    const add = (entry: SituationMonitorMonitorMatch["item"]) => {
      const key = `${entry.link}::${entry.title}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      items.push(entry);
    };

    const headlines = data?.headlines;
    if (headlines) {
      for (const [category, entries] of Object.entries(headlines) as [
        SituationMonitorCategory,
        SituationMonitorHeadline[]
      ][]) {
	        for (const entry of entries) {
	          add({
	            title: entry.title,
	            titleZh: entry.titleZh,
	            itemMetaId: entry.itemMetaId,
	            link: entry.link,
	            source: entry.source,
	            timestamp: entry.timestamp,
	            category,
	            summary: entry.summary,
	            summaryZh: entry.summaryZh,
	            keyPoints: entry.keyPoints,
	            keyPointsZh: entry.keyPointsZh,
	            topics: entry.topics,
	          });
	        }
	      }
	    }

	    for (const alert of data?.alerts ?? []) {
	      add({
	        title: alert.title,
	        titleZh: alert.titleZh,
	        itemMetaId: alert.itemMetaId,
	        link: alert.link,
	        source: alert.source,
	        timestamp: alert.timestamp,
	        category: `alert:${alert.category}`,
	        summary: alert.summary,
	        summaryZh: alert.summaryZh,
	        keyPoints: alert.keyPoints,
	        keyPointsZh: alert.keyPointsZh,
	        topics: alert.topics,
	      });
	    }

	    for (const panel of data?.situations ?? []) {
	      for (const entry of panel.headlines ?? []) {
	        add({
	          title: entry.title,
	          titleZh: entry.titleZh,
	          link: entry.link,
	          source: entry.source,
	          timestamp: entry.timestamp,
	          category: `situation:${panel.id}`,
	        });
	      }
	    }

    return items;
  }, [data?.alerts, data?.headlines, data?.situations]);

  const feedbackCandidateHeadlines = useMemo(() => {
    const headlinesByCategory = data?.headlines;
    if (!headlinesByCategory) {
      return [] as SituationMonitorHeadline[];
    }

    const entries = Object.values(headlinesByCategory).flatMap((list) => (Array.isArray(list) ? list : []));
    const results: SituationMonitorHeadline[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = entry.itemMetaId ?? entry.link;
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(entry);
      if (results.length >= 80) {
        break;
      }
    }
    return results;
  }, [data?.headlines]);

  const feedbackHeadlineById = useMemo(() => {
    return new Map<string, SituationMonitorHeadline>(feedbackCandidateHeadlines.map((headline) => [headline.id, headline]));
  }, [feedbackCandidateHeadlines]);

  useEffect(() => {
    scanMonitors(monitorScanItems);
  }, [monitorScanItems, monitors, scanMonitors]);

  const monitorColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const monitor of monitors) {
      if (monitor.color) {
        map.set(monitor.id, monitor.color);
      }
    }
    return map;
  }, [monitors]);

  const monitorMatchesByKey = useMemo(() => {
    const map = new Map<string, SituationMonitorMonitorMatch[]>();
    for (const match of monitorMatches) {
      const key = match.item.itemMetaId
        ? `id:${match.item.itemMetaId}`
        : `link:${match.item.link}::${match.item.title}`;
      const existing = map.get(key);
      if (existing) {
        existing.push(match);
      } else {
        map.set(key, [match]);
      }
    }

    for (const list of map.values()) {
      list.sort((a, b) => a.monitorName.localeCompare(b.monitorName));
    }

    return map;
  }, [monitorMatches]);

  const emergingColumns: ColumnsType<EmergingPattern> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>{translateToZh ? record.nameZh ?? record.name : record.name}</span>
          <Tag color={toTagColor(record.level)}>
            {t(`situationMonitor.correlation.level.${record.level.toLowerCase()}`, {
              defaultValue: record.level.toUpperCase(),
            })}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sources", { defaultValue: "Sources" }),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) => (Array.isArray(value) ? value.slice(0, 4).join(", ") : ""),
    },
	    {
	      title: t("situationMonitor.correlation.sample", { defaultValue: "Sample" }),
	      dataIndex: "headlines",
	      key: "headlines",
	      render: (value: HeadlineRef[]) => {
	        const first = Array.isArray(value) ? value[0] : undefined;
	        const href = first?.link ? safeHttpUrl(first.link) : null;
	        if (!first) return null;
	        const title = translateToZh ? first.titleZh ?? first.title : first.title;
	        return href ? (
	          <Typography.Link href={href} target="_blank" rel="noreferrer">
	            {title}
	          </Typography.Link>
	        ) : (
	          <Typography.Text>{title}</Typography.Text>
	        );
		            },
    },
    {
      title: t("situationMonitor.correlation.feedback", { defaultValue: "Feedback" }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines) ? record.headlines[0] : undefined;
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                <Space size={8} wrap>
                  <Tag color="red">FP {fpCount}</Tag>
                  <Tag color="gold">FN {fnCount}</Tag>
                  <Tag>SUP {suppressedCount}</Tag>
                </Space>
                {boosted.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            }
          >
            <Button
              size="small"
              danger
              onClick={() =>
                void submitSignalFeedback({
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? { itemMetaId: first.itemMetaId, title: first.title, source: first.source, link: first.link }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", { defaultValue: "False +" })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const momentumColumns: ColumnsType<MomentumSignal> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (translateToZh ? record.nameZh ?? record.name : record.name),
    },
    {
      title: t("situationMonitor.correlation.current", { defaultValue: "Current" }),
      dataIndex: "current",
      key: "current",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.delta", { defaultValue: "Δ" }),
      dataIndex: "delta",
      key: "delta",
      width: 80,
      render: (value: number) => (
        <Typography.Text type={value >= 0 ? "success" : "danger"}>{value}</Typography.Text>
      ),
    },
    {
      title: t("situationMonitor.correlation.momentum", { defaultValue: "Momentum" }),
      dataIndex: "momentum",
      key: "momentum",
      width: 110,
      render: (value: MomentumSignal["momentum"]) => {
        const normalized = value.toLowerCase();
        const color = normalized === "surging" ? "red" : normalized === "rising" ? "orange" : "default";
        return (
          <Tag color={color}>
            {t(`situationMonitor.correlation.momentumStatus.${normalized}`, {
              defaultValue: value.toUpperCase(),
            })}
          </Tag>
        );
      },
    },
    {
      title: t("situationMonitor.correlation.feedback", { defaultValue: "Feedback" }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines) ? record.headlines[0] : undefined;
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                <Space size={8} wrap>
                  <Tag color="red">FP {fpCount}</Tag>
                  <Tag color="gold">FN {fnCount}</Tag>
                  <Tag>SUP {suppressedCount}</Tag>
                </Space>
                {boosted.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-m-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-m-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            }
          >
            <Button
              size="small"
              danger
              onClick={() =>
                void submitSignalFeedback({
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? { itemMetaId: first.itemMetaId, title: first.title, source: first.source, link: first.link }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", { defaultValue: "False +" })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const predictiveColumns: ColumnsType<PredictiveSignal> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (translateToZh ? record.nameZh ?? record.name : record.name),
    },
    { title: t("situationMonitor.correlation.score", { defaultValue: "Score" }), dataIndex: "score", key: "score", width: 90 },
    { title: t("situationMonitor.correlation.confidence", { defaultValue: "Confidence" }), dataIndex: "confidence", key: "confidence", width: 120, render: (value: number) => `${value}%` },
    {
      title: t("situationMonitor.correlation.prediction", { defaultValue: "Prediction" }),
      dataIndex: "prediction",
      key: "prediction",
      render: (_value: string, record) =>
        translateToZh ? record.predictionZh ?? record.prediction : record.prediction,
    },
    {
      title: t("situationMonitor.correlation.feedback", { defaultValue: "Feedback" }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines) ? record.headlines[0] : undefined;
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                <Space size={8} wrap>
                  <Tag color="red">FP {fpCount}</Tag>
                  <Tag color="gold">FN {fnCount}</Tag>
                  <Tag>SUP {suppressedCount}</Tag>
                </Space>
                {boosted.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-p-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-p-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            }
          >
            <Button
              size="small"
              danger
              onClick={() =>
                void submitSignalFeedback({
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? { itemMetaId: first.itemMetaId, title: first.title, source: first.source, link: first.link }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", { defaultValue: "False +" })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const crossSourceColumns: ColumnsType<CrossSourceCorrelation> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>{translateToZh ? record.nameZh ?? record.name : record.name}</span>
          <Tag color={toTagColor(record.level)}>
            {t(`situationMonitor.correlation.level.${record.level.toLowerCase()}`, {
              defaultValue: record.level.toUpperCase(),
            })}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.sources", { defaultValue: "Sources" }),
      dataIndex: "sourceCount",
      key: "sourceCount",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sourcesList", { defaultValue: "Source list" }),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) => (Array.isArray(value) ? value.slice(0, 4).join(", ") : ""),
    },
	    {
	      title: t("situationMonitor.correlation.sample", { defaultValue: "Sample" }),
	      dataIndex: "headlines",
	      key: "headlines",
	      render: (value: HeadlineRef[]) => {
	        const first = Array.isArray(value) ? value[0] : undefined;
	        const href = first?.link ? safeHttpUrl(first.link) : null;
	        if (!first) return null;
	        const title = translateToZh ? first.titleZh ?? first.title : first.title;
	        return href ? (
	          <Typography.Link href={href} target="_blank" rel="noreferrer">
	            {title}
	          </Typography.Link>
	        ) : (
	          <Typography.Text>{title}</Typography.Text>
	        );
	      },
	    },
    {
      title: t("situationMonitor.correlation.feedback", { defaultValue: "Feedback" }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines) ? record.headlines[0] : undefined;
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                <Space size={8} wrap>
                  <Tag color="red">FP {fpCount}</Tag>
                  <Tag color="gold">FN {fnCount}</Tag>
                  <Tag>SUP {suppressedCount}</Tag>
                </Space>
                {boosted.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-x-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-x-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            }
          >
            <Button
              size="small"
              danger
              onClick={() =>
                void submitSignalFeedback({
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? { itemMetaId: first.itemMetaId, title: first.title, source: first.source, link: first.link }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", { defaultValue: "False +" })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
	  ];

  type CorrelationRow = EmergingPattern | MomentumSignal | CrossSourceCorrelation | PredictiveSignal;

  const correlationExpandable = useMemo(() => {
    return {
      rowExpandable: (record: CorrelationRow) => {
        const boosted = record.learning?.boostedTokens?.length ?? 0;
        const blocked = record.learning?.blockedTokens?.length ?? 0;
        const suppressed = record.learning?.suppressedCount ?? 0;
        const fp = record.feedback?.falsePositive ?? 0;
        const fn = record.feedback?.falseNegative ?? 0;
        return boosted > 0 || blocked > 0 || suppressed > 0 || fp > 0 || fn > 0;
      },
      expandedRowRender: (record: CorrelationRow) => {
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];

        return (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              {t("situationMonitor.correlation.learningHint", {
                defaultValue: "Feedback-driven learning: boosted/blocked tokens and per-item suppression.",
              })}
            </Typography.Text>
            <Space size={8} wrap>
              <Tag color="red">FP {fpCount}</Tag>
              <Tag color="gold">FN {fnCount}</Tag>
              <Tag>SUP {suppressedCount}</Tag>
            </Space>
            {boosted.length ? (
              <Space direction="vertical" size={2}>
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}
                </Typography.Text>
                <Space size={6} wrap>
                  {boosted.slice(0, 16).map((token) => (
                    <Tag key={`corr-boost-${record.id}-${token}`}>{token}</Tag>
                  ))}
                </Space>
              </Space>
            ) : null}
            {blocked.length ? (
              <Space direction="vertical" size={2}>
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}
                </Typography.Text>
                <Space size={6} wrap>
                  {blocked.slice(0, 16).map((token) => (
                    <Tag key={`corr-block-${record.id}-${token}`}>{token}</Tag>
                  ))}
                </Space>
              </Space>
            ) : null}
          </Space>
        );
      },
    };
  }, [t]);

  const narrativeColumns: ColumnsType<NarrativeData> = [
    {
      title: t("situationMonitor.narrative.name", { defaultValue: "Narrative" }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>{translateToZh ? record.nameZh ?? record.name : record.name}</span>
          <Tag color={record.severity === "disinfo" ? "red" : "default"}>
            {t(`situationMonitor.narrative.${record.severity.toLowerCase()}`, {
              defaultValue: record.severity.toUpperCase(),
            })}
          </Tag>
        </Space>
      ),
    },
    { title: t("situationMonitor.narrative.count", { defaultValue: "Count" }), dataIndex: "count", key: "count", width: 90 },
    { title: t("situationMonitor.narrative.fringe", { defaultValue: "Fringe" }), dataIndex: "fringeCount", key: "fringeCount", width: 90 },
    {
      title: t("situationMonitor.narrative.alternative", { defaultValue: "Alt" }),
      dataIndex: "alternativeCount",
      key: "alternativeCount",
      width: 80,
    },
    { title: t("situationMonitor.narrative.mainstream", { defaultValue: "Mainstream" }), dataIndex: "mainstreamCount", key: "mainstreamCount", width: 110 },
    {
      title: t("situationMonitor.narrative.radar", { defaultValue: "Radar" }),
      key: "radar",
      width: 140,
      render: (_, record) => {
        const radar = record.model?.crossSourceRadar;
        if (!radar) return "—";
        const consistency = Math.round((radar.consistency ?? 0) * 100);
        const divergence = Math.round((radar.divergence ?? 0) * 100);
        return (
          <Popover
            content={
              <Space direction="vertical" size={4}>
                <Typography.Text>
                  {t("situationMonitor.narrative.consistency", { defaultValue: "Consistency" })}: {consistency}%
                </Typography.Text>
                <Typography.Text>
                  {t("situationMonitor.narrative.divergence", { defaultValue: "Divergence" })}: {divergence}%
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.clusters", { defaultValue: "Clusters" })}: {radar.clusterCount ?? 0}
                </Typography.Text>
              </Space>
            }
          >
            <Progress percent={consistency} size="small" showInfo={false} />
          </Popover>
        );
      },
    },
    {
      title: t("situationMonitor.narrative.credibility", { defaultValue: "Credibility" }),
      key: "credibility",
      width: 130,
      render: (_, record) => {
        const credibility = record.model?.credibility;
        if (!credibility) return "—";
        const reasons = Array.isArray(credibility.reasons) ? credibility.reasons : [];
        const components = credibility.components;
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                {reasons.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>
                      {t("situationMonitor.narrative.credibilityReasons", { defaultValue: "Reasons" })}
                    </Typography.Text>
                    {reasons.slice(0, 4).map((reason) => (
                      <Typography.Text key={reason} type="secondary">
                        - {reason}
                      </Typography.Text>
                    ))}
                  </Space>
                ) : null}
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>
                    {t("situationMonitor.narrative.credibilityBreakdown", { defaultValue: "Breakdown" })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.sourceReliability", { defaultValue: "Source reliability" })}
                  </Typography.Text>
                  <Progress percent={Math.round((components.sourceReliability ?? 0) * 100)} size="small" showInfo={false} />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.corroboration", { defaultValue: "Corroboration" })}
                  </Typography.Text>
                  <Progress percent={Math.round((components.corroboration ?? 0) * 100)} size="small" showInfo={false} />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.citationSupport", { defaultValue: "Citation support" })}
                  </Typography.Text>
                  <Progress percent={Math.round((components.citationSupport ?? 0) * 100)} size="small" showInfo={false} />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.divergence", { defaultValue: "Divergence" })}
                  </Typography.Text>
                  <Progress percent={Math.round((components.divergence ?? 0) * 100)} size="small" showInfo={false} />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.feedbackPenalty", { defaultValue: "Feedback penalty" })}
                  </Typography.Text>
                  <Progress percent={Math.round((components.feedbackPenalty ?? 0) * 100)} size="small" showInfo={false} />
                </Space>
              </Space>
            }
          >
            <Tag color={toCredibilityColor(credibility.level)}>
              {t(`situationMonitor.narrative.credibilityLevel.${credibility.level.toLowerCase()}`, {
                defaultValue: credibility.level.toUpperCase(),
              })}{" "}
              {credibility.score}
            </Tag>
          </Popover>
        );
      },
    },
    {
      title: t("situationMonitor.narrative.feedback", { defaultValue: "Feedback" }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const headline = record.headlines?.[0];
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                <Space size={8} wrap>
                  <Tag color="red">FP {fpCount}</Tag>
                  <Tag color="gold">FN {fnCount}</Tag>
                  <Tag>SUP {suppressedCount}</Tag>
                </Space>
                {boosted.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`boost-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`block-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            }
          >
            <Button
              size="small"
              danger
              onClick={() =>
                void submitSignalFeedback({
                  signalType: "narrative",
                  signalId: record.id,
                  label: "false_positive",
                  item: headline
                    ? { itemMetaId: headline.itemMetaId, title: headline.title, source: headline.source, link: headline.link }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", { defaultValue: "False +" })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const narrativeExpandable = useMemo(() => {
    return {
      rowExpandable: (record: NarrativeData) => Boolean(record.model),
      expandedRowRender: (record: NarrativeData) => {
        const model = record.model;
        if (!model) return null;

        const path = model.fringeToMainstreamPath;
        const citation = model.citationChain;
        const radar = model.crossSourceRadar;
        const credibility = model.credibility;

        const stepsLabel = path.steps
          .filter((step) => step.tier !== "unknown")
          .map((step) => step.tier)
          .join(" → ");
        const lagLabel = path.lagToMainstreamMs ? formatDurationMs(path.lagToMainstreamMs) : "—";

        return (
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.path", { defaultValue: "Fringe → Mainstream Path" })}
              </Typography.Text>
              <div className="mt-1">
                <Typography.Text>{stepsLabel || "—"}</Typography.Text>
              </div>
              <div className="mt-1">
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.lag", { defaultValue: "Lag to mainstream" })}: {lagLabel}
                </Typography.Text>
              </div>
              <div className="mt-2">
                <Space direction="vertical" size={2}>
                  {path.steps.map((step) => {
                    const firstSeen = step.firstSeenAt ? new Date(step.firstSeenAt) : null;
                    const lastSeen = step.lastSeenAt ? new Date(step.lastSeenAt) : null;
                    return (
                      <Typography.Text key={step.tier} type="secondary">
                        {step.tier.toUpperCase()}: {step.count}{" "}
                        {firstSeen
                          ? `(${formatDateTime(firstSeen, locale, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })} → ${
                              lastSeen
                                ? formatDateTime(lastSeen, locale, {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "—"
                            })`
                          : ""}
                      </Typography.Text>
                    );
                  })}
                </Space>
              </div>
            </Col>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.radarDetail", { defaultValue: "Cross-source Radar" })}
              </Typography.Text>
              <div className="mt-2">
                <Space size={10} wrap>
                  <Tag color="geekblue">
                    {t("situationMonitor.narrative.consistency", { defaultValue: "Consistency" })}:{" "}
                    {Math.round((radar.consistency ?? 0) * 100)}%
                  </Tag>
                  <Tag color="gold">
                    {t("situationMonitor.narrative.divergence", { defaultValue: "Divergence" })}:{" "}
                    {Math.round((radar.divergence ?? 0) * 100)}%
                  </Tag>
                  <Tag>
                    {t("situationMonitor.narrative.clusters", { defaultValue: "Clusters" })}: {radar.clusterCount ?? 0}
                  </Tag>
                  <Tag color={toCredibilityColor(credibility.level)}>
                    {t("situationMonitor.narrative.credibility", { defaultValue: "Credibility" })}: {credibility.score}
                  </Tag>
                </Space>
              </div>
              {credibility.reasons?.length ? (
                <div className="mt-2">
                  <Space direction="vertical" size={2}>
                    {credibility.reasons.slice(0, 4).map((reason) => (
                      <Typography.Text key={reason} type="secondary">
                        - {reason}
                      </Typography.Text>
                    ))}
                  </Space>
                </div>
              ) : null}
              {radar.outlierSources?.length ? (
                <div className="mt-2">
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.outliers", { defaultValue: "Outliers" })}:
                  </Typography.Text>
                  <div className="mt-1">
                    <Space size={6} wrap>
                      {radar.outlierSources.slice(0, 8).map((source) => (
                        <Tag key={source}>{source}</Tag>
                      ))}
                    </Space>
                  </div>
                </div>
              ) : null}
              {radar.clusters?.length ? (
                <div className="mt-2">
                  <Space direction="vertical" size={4} style={{ width: "100%" }}>
                    {radar.clusters.slice(0, 4).map((cluster) => (
                      <div key={cluster.id}>
                        <Typography.Text type="secondary">
                          {cluster.id}: {cluster.itemCount}{" "}
                          {cluster.sources?.length ? `· ${cluster.sources.slice(0, 4).join(", ")}` : ""}
                        </Typography.Text>
                      </div>
                    ))}
                  </Space>
                </div>
              ) : null}
            </Col>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.citations", { defaultValue: "Citation Chain" })}
              </Typography.Text>
              <div className="mt-2">
                {citation.topCited?.length ? (
                  <Space size={6} wrap>
                    {citation.topCited.slice(0, 8).map((entry) => (
                      <Tag key={entry.source} color="cyan">
                        {entry.source} · {entry.weight}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                )}
              </div>
              {citation.links?.length ? (
                <div className="mt-2">
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.citationLinks", { defaultValue: "Top links" })}
                  </Typography.Text>
                  <div className="mt-1">
                    <Space direction="vertical" size={2}>
                      {citation.links.slice(0, 6).map((link) => (
                        <Typography.Text key={`${link.from}=>${link.to}`} type="secondary">
                          {link.from} → {link.to} ({link.weight})
                        </Typography.Text>
                      ))}
                    </Space>
                  </div>
                </div>
              ) : null}
              {record.learning?.boostedTokens?.length ||
              record.learning?.blockedTokens?.length ||
              (record.learning?.suppressedCount ?? 0) > 0 ||
              (record.feedback?.falsePositive ?? 0) > 0 ||
              (record.feedback?.falseNegative ?? 0) > 0 ? (
                <div className="mt-3">
                  <Typography.Text strong>
                    {t("situationMonitor.narrative.learning", { defaultValue: "Learning" })}
                  </Typography.Text>
                  <div className="mt-2">
                    <Space size={8} wrap>
                      <Tag color="red">FP {record.feedback?.falsePositive ?? 0}</Tag>
                      <Tag color="gold">FN {record.feedback?.falseNegative ?? 0}</Tag>
                      <Tag>SUP {record.learning?.suppressedCount ?? 0}</Tag>
                    </Space>
                    {record.learning?.boostedTokens?.length ? (
                      <Space size={6} wrap>
                        <Typography.Text type="secondary">
                          {t("situationMonitor.narrative.boosted", { defaultValue: "Boosted" })}:
                        </Typography.Text>
                        {record.learning.boostedTokens.slice(0, 8).map((token) => (
                          <Tag key={`boost-${token}`}>{token}</Tag>
                        ))}
                      </Space>
                    ) : null}
                    {record.learning?.blockedTokens?.length ? (
                      <div className="mt-1">
                        <Space size={6} wrap>
                          <Typography.Text type="secondary">
                            {t("situationMonitor.narrative.blocked", { defaultValue: "Blocked" })}:
                          </Typography.Text>
                          {record.learning.blockedTokens.slice(0, 8).map((token) => (
                            <Tag key={`block-${token}`}>{token}</Tag>
                          ))}
                        </Space>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Col>
          </Row>
        );
      },
    };
  }, [locale, t]);

  const mainCharacterColumns: ColumnsType<MainCharacterEntry> = [
    { title: "#", dataIndex: "rank", key: "rank", width: 60 },
    { title: t("situationMonitor.mainCharacter.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
    { title: t("situationMonitor.mainCharacter.count", { defaultValue: "Mentions" }), dataIndex: "count", key: "count", width: 110 },
  ];

  const categoryLabels: Record<SituationMonitorCategory, string> = useMemo(
    () => ({
      politics: t("situationMonitor.categories.politics", { defaultValue: "Politics" }),
      tech: t("situationMonitor.categories.tech", { defaultValue: "Tech" }),
      finance: t("situationMonitor.categories.finance", { defaultValue: "Finance" }),
      gov: t("situationMonitor.categories.gov", { defaultValue: "Government" }),
      ai: t("situationMonitor.categories.ai", { defaultValue: "AI" }),
      intel: t("situationMonitor.categories.intel", { defaultValue: "Intel" }),
    }),
    [t],
  );

  const feedItemsPerCategory = screens.lg ? 6 : 4;
  const alertsPerPanel = screens.lg ? 10 : 6;
  const fedNewsPerPanel = screens.lg ? 8 : 5;
  const telegramItemsPerPanel = screens.lg ? 14 : 10;
  const orefAlertsPerPanel = screens.lg ? 12 : 8;
  const orefHistoryPerPanel = screens.lg ? 6 : 4;

  const updatedAt = data?.generatedAt ? dayjs(data.generatedAt).toDate() : null;
  const marketsSnapshot = data?.markets;
  const cryptoSnapshot = data?.crypto;
  const fedSnapshot = data?.fed;

  const layout = useSituationMonitorLayoutStore((state) => state.layout);
  const visibility = useSituationMonitorLayoutStore((state) => state.visibility);
  const setLayout = useSituationMonitorLayoutStore((state) => state.setLayout);
  const setPanelVisible = useSituationMonitorLayoutStore((state) => state.setPanelVisible);
  const applyPreset = useSituationMonitorLayoutStore((state) => state.applyPreset);
  const resetPanels = useSituationMonitorLayoutStore((state) => state.reset);
  const ensurePanels = useSituationMonitorLayoutStore((state) => state.ensure);

  const [panelsOpen, setPanelsOpen] = useState(false);
  const resetLayoutOnPreset = useSituationMonitorSettingsStore((state) => state.resetLayoutOnPreset);
  const setResetLayoutOnPreset = useSituationMonitorSettingsStore((state) => state.setResetLayoutOnPreset);

  const activePreset = useMemo(() => {
    return (
      SITUATION_MONITOR_PRESETS.find((preset) =>
        isVisibilityMatchingPreset(visibility, preset.panels)
      ) ?? null
    );
  }, [visibility]);

  useEffect(() => {
    ensurePanels();
  }, [ensurePanels]);

  const visiblePanels = useMemo(
    () => SITUATION_MONITOR_PANELS.filter((panel) => visibility[panel.id]),
    [visibility],
  );

  const visibleLayout = useMemo(
    () => stretchCorrelationToMonitorArea(layout.filter((item) => visibility[item.i as SituationMonitorPanelId])),
    [layout, visibility],
  );

  const gridMargin: [number, number] = screens.md ? [16, 16] : [12, 12];

  type GridBreakpoint = keyof typeof GRID_COLS;
  const [gridBreakpoint, setGridBreakpoint] = useState<GridBreakpoint>("xxs");

  const handleGridBreakpointChange = useCallback((next: string) => {
    if (next in GRID_COLS) {
      const breakpoint = next as GridBreakpoint;
      setGridBreakpoint(breakpoint);
    }
  }, []);

  const canEditLayout = gridBreakpoint === "lg" || gridBreakpoint === "md";

  const gridLayouts = useMemo(
    () => ({
      lg: visibleLayout.map((item) => ({ ...item })),
      md: buildPackedResponsiveLayout(visibleLayout, GRID_COLS.md),
      sm: buildPackedResponsiveLayout(visibleLayout, GRID_COLS.sm),
      xs: buildPackedResponsiveLayout(visibleLayout, GRID_COLS.xs),
      xxs: buildPackedResponsiveLayout(visibleLayout, GRID_COLS.xxs),
    }),
    [visibleLayout],
  );

  const handleLayoutChange = useCallback(
    (nextLayout: Layout[]) => {
      const cols = GRID_COLS[gridBreakpoint] ?? GRID_COLS.lg;
      const normalized = projectLayoutToLg(nextLayout, cols);
      setLayout(mergePanelLayouts(layout, normalized));
    },
    [gridBreakpoint, layout, setLayout],
  );

  const initialLoading = loading && !data;

  const renderHeadlineSummary = (entry: SituationMonitorHeadline) => {
    const rawSummary = translateToZh ? entry.summaryZh ?? entry.summary : entry.summary;
    const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
    if (!summary) return null;
    return (
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2 }}
        style={{ marginBottom: 0 }}
      >
        {summary}
      </Typography.Paragraph>
    );
  };

  const renderHeadlineTopics = (entry: SituationMonitorHeadline, limit = 3) => {
    const topics = Array.isArray(entry.topics)
      ? entry.topics
          .filter((topic) => typeof topic === "string" && topic.trim().length > 0)
          .slice(0, limit)
      : [];
    if (topics.length === 0) return null;
    return topics.map((topic) => (
      <Tag
        key={`${entry.id}:${topic}`}
        color="default"
        className="cursor-pointer"
        onClick={() =>
          window.open(`/search?q=${encodeURIComponent(topic)}`, "_blank", "noopener,noreferrer")
        }
      >
        {topic}
      </Tag>
    ));
  };

  const renderHeadlineDetails = (entry: SituationMonitorHeadline) => {
    const summarySource = translateToZh ? entry.summaryZh ?? entry.summary : entry.summary;
    const summary = typeof summarySource === "string" ? summarySource.trim() : "";

    const keyPointsSource = translateToZh ? entry.keyPointsZh ?? entry.keyPoints : entry.keyPoints;
    const keyPoints = Array.isArray(keyPointsSource)
      ? keyPointsSource
          .filter((point) => typeof point === "string" && point.trim().length > 0)
          .slice(0, 5)
      : [];
    const topics = Array.isArray(entry.topics)
      ? entry.topics
          .filter((topic) => typeof topic === "string" && topic.trim().length > 0)
          .slice(0, 12)
      : [];

    if (!summary && keyPoints.length === 0 && topics.length === 0) {
      return null;
    }

    const title = t("situationMonitor.headlines.summary", { defaultValue: "Summary" });

    return (
      <Popover
        trigger="click"
        placement="left"
        title={title}
        content={
          <Space direction="vertical" size={8} style={{ maxWidth: 420 }}>
            {summary ? (
              <Typography.Paragraph style={{ marginBottom: 0 }}>{summary}</Typography.Paragraph>
            ) : null}
            {keyPoints.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {keyPoints.map((point) => (
                  <li key={point}>
                    <Typography.Text>{point}</Typography.Text>
                  </li>
                ))}
              </ul>
            ) : null}
            {topics.length > 0 ? (
              <Space size={4} wrap>
                {topics.map((topic) => (
                  <Tag
                    key={topic}
                    color="default"
                    className="cursor-pointer"
                    onClick={() =>
                      window.open(`/search?q=${encodeURIComponent(topic)}`, "_blank", "noopener,noreferrer")
                    }
                  >
                    {topic}
                  </Tag>
                ))}
              </Space>
            ) : null}
          </Space>
        }
      >
        <Button
          size="small"
          type="text"
          icon={<InfoCircleOutlined />}
          aria-label={title}
        />
      </Popover>
    );
  };

  const renderHeadlineItemLink = (entry: SituationMonitorHeadline) => {
    if (!entry.itemMetaId) {
      return null;
    }
    const title = t("situationMonitor.headlines.openItem", { defaultValue: "Open item" });
    return (
      <Button
        size="small"
        type="text"
        icon={<FileSearchOutlined />}
        aria-label={title}
        onClick={() =>
          window.open(`/items/${encodeURIComponent(entry.itemMetaId!)}`, "_blank", "noopener,noreferrer")
        }
      />
    );
  };

  const renderHeadlineMonitorMatches = (entry: SituationMonitorHeadline) => {
    const matchKey = entry.itemMetaId ? `id:${entry.itemMetaId}` : `link:${entry.link}::${entry.title}`;
    const matches = monitorMatchesByKey.get(matchKey);
    if (!matches || matches.length === 0) {
      return null;
    }

    const title = t("situationMonitor.monitors.matchTitle", {
      defaultValue: "Monitor matches",
    });

    const preview = matches.slice(0, 2);
    const remaining = Math.max(0, matches.length - preview.length);

    return (
      <Popover
        trigger="hover"
        placement="bottom"
        title={title}
        content={
          <Space direction="vertical" size={6} style={{ maxWidth: 520 }}>
            {matches.map((match) => (
              <Space key={`${matchKey}:${match.monitorId}`} size={6} wrap>
                <Tag color={monitorColorById.get(match.monitorId)}>{match.monitorName}</Tag>
                {match.matchedKeywords.map((keyword) => (
                  <Tag
                    key={keyword}
                    color="default"
                    className="cursor-pointer"
                    onClick={() =>
                      window.open(`/search?q=${encodeURIComponent(keyword)}`, "_blank", "noopener,noreferrer")
                    }
                  >
                    {keyword}
                  </Tag>
                ))}
              </Space>
            ))}
          </Space>
        }
      >
        <Space size={4} wrap>
          {preview.map((match) => (
            <Tag key={`${entry.id}:${match.monitorId}`} color={monitorColorById.get(match.monitorId)}>
              {match.monitorName}
            </Tag>
          ))}
          {remaining > 0 ? <Tag color="default">+{remaining}</Tag> : null}
        </Space>
      </Popover>
    );
  };

  const renderFeedPanel = (category: SituationMonitorCategory) => {
    const entries = data?.headlines?.[category] ?? [];
    return (
      <Card
        title={
          <Space size={10}>
            <span>{categoryLabels[category]}</span>
            <Tag color="geekblue">{entries.length}</Tag>
          </Space>
        }
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        size="small"
        loading={initialLoading}
      >
        {entries.length === 0 ? (
          <Typography.Text type="secondary">
            {t("situationMonitor.feeds.empty", { defaultValue: "No headlines yet." })}
          </Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={entries.slice(0, feedItemsPerCategory)}
            renderItem={(entry) => {
              const href = entry.link ? safeHttpUrl(entry.link) : null;
              const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
              return (
                <List.Item key={entry.id}>
                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                    <Space size={8} wrap>
                      {entry.isAlert ? (
                        <Tag color="red">{t("situationMonitor.feeds.alert", { defaultValue: "ALERT" })}</Tag>
                      ) : null}
                      {entry.origin === "gdelt" ? <Tag color="purple">GDELT</Tag> : null}
                      {renderHeadlineMonitorMatches(entry)}
	                      {href ? (
	                        <Typography.Link href={href} target="_blank" rel="noreferrer">
	                          {translateToZh ? entry.titleZh ?? entry.title : entry.title}
	                        </Typography.Link>
	                      ) : (
	                        <Typography.Text>
	                          {translateToZh ? entry.titleZh ?? entry.title : entry.title}
	                        </Typography.Text>
	                      )}
                      {renderHeadlineItemLink(entry)}
                      {renderHeadlineDetails(entry)}
                    </Space>
                    {renderHeadlineSummary(entry)}
                    <Space size={8} wrap>
                      <Typography.Text type="secondary">{entry.source}</Typography.Text>
                      {date ? (
                        <Typography.Text type="secondary">
                          {formatDateTime(date, locale, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Typography.Text>
                      ) : null}
                      {entry.alertKeyword ? (
                        <Typography.Text type="secondary">{entry.alertKeyword}</Typography.Text>
                      ) : null}
                      {renderHeadlineTopics(entry)}
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    );
  };

  const renderAlertsPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.alerts.title", { defaultValue: "Alerts" })}</span>
          <Tag color="geekblue">{data?.alerts?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      {data?.alerts?.length ? (
        <List
          size="small"
          dataSource={data.alerts.slice(0, alertsPerPanel)}
          renderItem={(entry) => {
            const href = entry.link ? safeHttpUrl(entry.link) : null;
            const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
            return (
              <List.Item key={entry.id}>
                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                    <Space size={8} wrap>
                      <Tag color={entry.severity === "critical" ? "red" : "orange"}>{entry.severity.toUpperCase()}</Tag>
                      <Tag color="blue">{categoryLabels[entry.category]}</Tag>
                      {renderHeadlineMonitorMatches(entry)}
	                      {href ? (
	                        <Typography.Link href={href} target="_blank" rel="noreferrer">
	                          {translateToZh ? entry.titleZh ?? entry.title : entry.title}
	                        </Typography.Link>
	                      ) : (
	                      <Typography.Text>
	                        {translateToZh ? entry.titleZh ?? entry.title : entry.title}
	                      </Typography.Text>
	                    )}
                    {renderHeadlineItemLink(entry)}
                    {renderHeadlineDetails(entry)}
                  </Space>
                  {renderHeadlineSummary(entry)}
                  <Space size={8} wrap>
                    <Typography.Text type="secondary">{entry.source}</Typography.Text>
                    {date ? (
                      <Typography.Text type="secondary">
                        {formatDateTime(date, locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Typography.Text>
                    ) : null}
                    {entry.alertKeyword ? (
                      <Typography.Text type="secondary">{entry.alertKeyword}</Typography.Text>
                    ) : null}
                    {renderHeadlineTopics(entry)}
                  </Space>
                </Space>
              </List.Item>
            );
          }}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("situationMonitor.alerts.empty", { defaultValue: "No alerts in the current window." })}
        </Typography.Text>
      )}
    </Card>
  );

  const renderMarketsPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.markets.title", { defaultValue: "Markets" })}</span>
          {marketsSnapshot && !marketsSnapshot.hasFinnhubApiKey ? (
            <Tag color="default">{t("situationMonitor.markets.missingKey", { defaultValue: "API key needed" })}</Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading || (refreshStage === "external" && marketsSnapshot === undefined)}
    >
      {marketsSnapshot?.error ? <Alert type="warning" showIcon message={marketsSnapshot.error} /> : null}
      {marketsSnapshot ? (
        !marketsSnapshot.hasFinnhubApiKey ? (
          <Typography.Text type="secondary">
            {t("situationMonitor.markets.hint", {
              defaultValue: "Configure Finnhub API key in Admin Settings > System Settings > Situation Monitor.",
            })}
          </Typography.Text>
        ) : (
          <>
            <Table
              rowKey="symbol"
              size="small"
              pagination={false}
              columns={[
                { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                {
                  title: t("situationMonitor.markets.price", { defaultValue: "Price" }),
                  dataIndex: "price",
                  key: "price",
                  width: 120,
                  render: (value: number) => formatUsd(value, locale),
                },
                {
                  title: t("situationMonitor.markets.changePct", { defaultValue: "Change" }),
                  dataIndex: "changePercent",
                  key: "changePercent",
                  width: 110,
                  render: (value: number) => (
                    <Typography.Text type={Number.isFinite(value) && value < 0 ? "danger" : "success"}>
                      {formatPercent(value)}
                    </Typography.Text>
                  ),
                },
              ]}
              dataSource={(marketsSnapshot.indices ?? []).slice(0, 4)}
            />
            <Divider style={{ margin: "12px 0" }} />
            <Table
              rowKey="symbol"
              size="small"
              pagination={false}
              columns={[
                { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                {
                  title: t("situationMonitor.markets.price", { defaultValue: "Price" }),
                  dataIndex: "price",
                  key: "price",
                  width: 120,
                  render: (value: number) => formatUsd(value, locale),
                },
                {
                  title: t("situationMonitor.markets.changePct", { defaultValue: "Change" }),
                  dataIndex: "changePercent",
                  key: "changePercent",
                  width: 110,
                  render: (value: number) => (
                    <Typography.Text type={Number.isFinite(value) && value < 0 ? "danger" : "success"}>
                      {formatPercent(value)}
                    </Typography.Text>
                  ),
                },
              ]}
              dataSource={(marketsSnapshot.commodities ?? []).slice(0, 3)}
            />
          </>
        )
      ) : (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading", { defaultValue: "Loading" })
            : t("situationMonitor.markets.empty", { defaultValue: "No markets data yet." })}
        </Typography.Text>
      )}
    </Card>
  );

  const renderCryptoPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.crypto.title", { defaultValue: "Crypto" })}</span>
          <Tag color="geekblue">{cryptoSnapshot?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading || (refreshStage === "external" && cryptoSnapshot === undefined)}
    >
      {!cryptoSnapshot ? (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading", { defaultValue: "Loading" })
            : t("situationMonitor.crypto.empty", { defaultValue: "No crypto data." })}
        </Typography.Text>
      ) : cryptoSnapshot.length ? (
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
            {
              title: t("situationMonitor.crypto.price", { defaultValue: "Price" }),
              dataIndex: "currentPriceUsd",
              key: "currentPriceUsd",
              width: 130,
              render: (value: number) => formatUsd(value, locale),
            },
            {
              title: t("situationMonitor.crypto.change24h", { defaultValue: "24h" }),
              dataIndex: "change24hPercent",
              key: "change24hPercent",
              width: 110,
              render: (value: number) => (
                <Typography.Text type={Number.isFinite(value) && value < 0 ? "danger" : "success"}>
                  {formatPercent(value)}
                </Typography.Text>
              ),
            },
          ]}
          dataSource={cryptoSnapshot}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("situationMonitor.crypto.empty", { defaultValue: "No crypto data." })}
        </Typography.Text>
      )}
    </Card>
  );

  const renderFedPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.fed.title", { defaultValue: "Federal Reserve" })}</span>
          {fedSnapshot && !fedSnapshot.hasFredApiKey ? <Tag color="default">FRED API</Tag> : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading || (refreshStage === "external" && fedSnapshot === undefined)}
    >
      {!fedSnapshot ? (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading", { defaultValue: "Loading" })
            : t("situationMonitor.fed.empty", { defaultValue: "No Federal Reserve data yet." })}
        </Typography.Text>
      ) : (
        <>
          {fedSnapshot.error ? <Alert type="warning" showIcon message={fedSnapshot.error} /> : null}
          {!fedSnapshot.hasFredApiKey ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.fed.hint", {
                defaultValue: "Configure FRED API key in Admin Settings > System Settings > Situation Monitor.",
              })}
            </Typography.Text>
          ) : fedSnapshot.indicators?.length ? (
            <Table
              rowKey="seriesId"
              size="small"
              pagination={false}
              columns={[
                { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                {
                  title: t("situationMonitor.fed.value", { defaultValue: "Value" }),
                  dataIndex: "value",
                  key: "value",
                  width: 110,
                  render: (value: number | null, record: SituationMonitorFedIndicator) =>
                    value === null ? "—" : `${value.toFixed(2)}${record.unit}`,
                },
                {
                  title: t("situationMonitor.fed.delta", { defaultValue: "Δ" }),
                  dataIndex: "change",
                  key: "change",
                  width: 90,
                  render: (value: number | null) =>
                    value === null ? (
                      "—"
                    ) : (
                      <Typography.Text type={value < 0 ? "danger" : "success"}>
                        {value > 0 ? "+" : ""}
                        {value.toFixed(2)}
                      </Typography.Text>
                    ),
                },
              ]}
              dataSource={fedSnapshot.indicators}
            />
          ) : null}

          {fedSnapshot.moneyPrinter ? (
            <>
              <Divider style={{ margin: "12px 0" }} />
              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                <Space size={10} wrap>
                  <Tag color={fedSnapshot.moneyPrinter.changeTrillions > 0 ? "green" : "red"}>
                    {fedSnapshot.moneyPrinter.changeTrillions > 0 ? "PRINTER ON" : "PRINTER OFF"}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.fed.balanceSheet", { defaultValue: "Balance sheet" })}:{" "}
                    {fedSnapshot.moneyPrinter.valueTrillions.toFixed(2)}T
                  </Typography.Text>
                  <Typography.Text type={fedSnapshot.moneyPrinter.changePercent < 0 ? "danger" : "success"}>
                    {fedSnapshot.moneyPrinter.changeTrillions > 0 ? "+" : ""}
                    {(fedSnapshot.moneyPrinter.changeTrillions * 1000).toFixed(0)}B (
                    {fedSnapshot.moneyPrinter.changePercent > 0 ? "+" : ""}
                    {fedSnapshot.moneyPrinter.changePercent.toFixed(2)}%)
                  </Typography.Text>
                </Space>
                <Progress percent={Math.min(100, Math.max(0, fedSnapshot.moneyPrinter.percentOfMax))} showInfo={false} />
              </Space>
            </>
          ) : null}

          {fedSnapshot.news?.length ? (
            <>
              <Divider style={{ margin: "12px 0" }} />
              <List
                size="small"
	                dataSource={fedSnapshot.news.slice(0, fedNewsPerPanel)}
	                renderItem={(item) => {
	                  const href = item.link ? safeHttpUrl(item.link) : null;
	                  const date = Number.isFinite(item.timestamp) ? new Date(item.timestamp) : null;
	                  const title = translateToZh ? item.titleZh ?? item.title : item.title;
	                  const description = translateToZh ? item.descriptionZh ?? item.description : item.description;
	                  const descriptionText = typeof description === "string" ? description.trim() : "";
	                  return (
	                    <List.Item key={item.id}>
	                      <Space direction="vertical" size={2} style={{ width: "100%" }}>
	                        <Space size={8} wrap>
	                          <Tag color={item.type === "powell" ? "orange" : "blue"}>
	                            {translateToZh ? item.typeLabelZh ?? item.typeLabel : item.typeLabel}
	                          </Tag>
	                          {item.hasVideo ? <Tag color="purple">VIDEO</Tag> : null}
	                          {href ? (
	                            <Typography.Link href={href} target="_blank" rel="noreferrer">
	                              {title}
	                            </Typography.Link>
	                          ) : (
	                            <Typography.Text>{title}</Typography.Text>
	                          )}
	                        </Space>
	                        {descriptionText ? (
	                          <Typography.Paragraph
	                            type="secondary"
	                            ellipsis={{ rows: 2 }}
	                            style={{ marginBottom: 0 }}
	                          >
	                            {descriptionText}
	                          </Typography.Paragraph>
	                        ) : null}
	                        <Space size={8} wrap>
	                          <ArticlePublishedTime
	                            publishedAt={date?.toISOString() ?? null}
	                            locale={locale}
	                            formatOptions={{
	                              dateStyle: "medium",
	                              timeStyle: "short",
	                              timeZoneName: "short"
	                            }}
	                            primaryStrong
	                            secondaryStyle={{ fontSize: 12 }}
	                          />
                          {item.isPowellRelated && item.type !== "powell" ? <Tag color="orange">POWELL</Tag> : null}
                        </Space>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </>
          ) : null}
        </>
      )}
    </Card>
  );

  const renderLeadersPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.leaders.title", { defaultValue: "World Leaders" })}</span>
          <Tag color="geekblue">{data?.leaders?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Table
        rowKey="id"
        size="small"
        pagination={{ pageSize: screens.lg ? 8 : 6, hideOnSinglePage: true }}
        columns={[
          {
            title: t("situationMonitor.leaders.leader", { defaultValue: "Leader" }),
            dataIndex: "name",
            key: "name",
            render: (_: string, record: SituationMonitorWorldLeader) => (
              <Space size={8}>
                {record.flag ? <span>{record.flag}</span> : null}
                <span>{record.name}</span>
                <Typography.Text type="secondary">{record.country}</Typography.Text>
              </Space>
            ),
          },
          {
            title: t("situationMonitor.leaders.mentions", { defaultValue: "Mentions" }),
            dataIndex: "matchCount",
            key: "matchCount",
            width: 110,
          },
          {
            title: t("situationMonitor.leaders.sample", { defaultValue: "Sample" }),
            dataIndex: "headlines",
            key: "headlines",
            render: (value: SituationMonitorWorldLeader["headlines"]) => {
              const first = Array.isArray(value) ? value[0] : undefined;
              const href = first?.link ? safeHttpUrl(first.link) : null;
              if (!first) return <Typography.Text type="secondary">—</Typography.Text>;
              const title = translateToZh ? first.titleZh ?? first.title : first.title;
              return href ? (
                <Typography.Link href={href} target="_blank" rel="noreferrer">
                  {title}
                </Typography.Link>
              ) : (
                <Typography.Text>{title}</Typography.Text>
              );
            },
          },
        ]}
        dataSource={(data?.leaders ?? []).filter((leader) => leader.matchCount > 0)}
      />
    </Card>
  );

  const renderSituationPanel = (id: SituationMonitorSituationPanel["id"], fallbackTitle: string) => {
    const panel = (data?.situations ?? []).find((entry) => entry.id === id) ?? null;
    const statusTag = panel ? (
      <Tag color={panel.level === "critical" ? "red" : panel.level === "elevated" ? "orange" : "default"}>
        {panel.status}
      </Tag>
    ) : refreshStage === "core" ? (
      <Tag color="default">{t("common.loading", { defaultValue: "Loading" })}</Tag>
    ) : null;

    return (
      <Card
	        title={
	          <Space size={10}>
	            <span>
	              {panel
	                ? translateToZh
	                  ? panel.titleZh ?? panel.title
	                  : panel.title
	                : fallbackTitle}
	            </span>
	            {statusTag}
	          </Space>
	        }
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        loading={initialLoading}
      >
	        {panel?.subtitle ? (
	          <Typography.Text type="secondary">
	            {translateToZh ? panel.subtitleZh ?? panel.subtitle : panel.subtitle}
	          </Typography.Text>
	        ) : (
          <Typography.Text type="secondary">
            {refreshStage === "core"
              ? t("common.loading", { defaultValue: "Loading" })
              : t("situationMonitor.situations.empty", { defaultValue: "No recent headlines." })}
          </Typography.Text>
        )}
        <div className="mt-3">
          {panel?.headlines?.length ? (
            <List
              size="small"
              dataSource={panel.headlines.slice(0, 6)}
              renderItem={(entry, index) => {
                const key = `${panel.id}-${index}`;
                const href = entry.link ? safeHttpUrl(entry.link) : null;
                const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
                return (
                  <List.Item key={key}>
	                    <Space direction="vertical" size={2} style={{ width: "100%" }}>
	                      {href ? (
	                        <Typography.Link href={href} target="_blank" rel="noreferrer">
	                          {translateToZh ? entry.titleZh ?? entry.title : entry.title}
	                        </Typography.Link>
	                      ) : (
	                        <Typography.Text>
	                          {translateToZh ? entry.titleZh ?? entry.title : entry.title}
	                        </Typography.Text>
	                      )}
                      <Space size={8} wrap>
                        <Typography.Text type="secondary">{entry.source}</Typography.Text>
                        {date ? (
                          <Typography.Text type="secondary">
                            {formatDateTime(date, locale, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    </Space>
                  </List.Item>
                );
              }}
            />
          ) : (
            <Typography.Text type="secondary">
              {t("situationMonitor.situations.empty", { defaultValue: "No recent headlines." })}
            </Typography.Text>
          )}
        </div>
      </Card>
    );
  };

  const renderTelegramFeedPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.telegram.title", { defaultValue: "Telegram Early Signals" })}</span>
          <Tag color="geekblue">{telegramFeed?.count ?? telegramFeed?.items?.length ?? 0}</Tag>
          {telegramFeed && !telegramFeed.configured ? (
            <Tag color="default">
              {t("situationMonitor.telegram.configMissing", { defaultValue: "Not configured" })}
            </Tag>
          ) : null}
          {telegramFeed && !telegramFeed.enabled ? (
            <Tag color="orange">
              {t("situationMonitor.telegram.disabled", { defaultValue: "Disabled" })}
            </Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={signalsLoading.telegram && !telegramFeed}
    >
      {telegramFeed?.error ? <Alert type="warning" showIcon message={telegramFeed.error} /> : null}
      {!telegramFeed ? (
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading" })}
        </Typography.Text>
      ) : !telegramFeed.configured ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.configHint", {
            defaultValue: "Configure Telegram API credentials and session in environment variables.",
          })}
        </Typography.Text>
      ) : telegramFeed.items.length === 0 ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.empty", { defaultValue: "No Telegram signals yet." })}
        </Typography.Text>
      ) : (
        <List
          size="small"
          dataSource={telegramFeed.items.slice(0, telegramItemsPerPanel)}
          renderItem={(item) => {
            const href = item.url ? safeHttpUrl(item.url) : null;
            const date = item.ts ? new Date(item.ts) : null;
            const text = typeof item.text === "string" ? item.text.trim() : "";
            return (
              <List.Item key={item.id}>
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Space size={8} wrap>
                    <Tag color="blue">{item.channelTitle || item.channel}</Tag>
                    {item.topic ? <Tag color="default">{item.topic}</Tag> : null}
                  </Space>
                  {href ? (
                    <Typography.Link href={href} target="_blank" rel="noreferrer">
                      {text}
                    </Typography.Link>
                  ) : (
                    <Typography.Text>{text}</Typography.Text>
                  )}
                  <Space size={8} wrap>
                    {date && !Number.isNaN(date.getTime()) ? (
                      <Typography.Text type="secondary">
                        {formatDateTime(date, locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Typography.Text>
                    ) : null}
                    {Array.isArray(item.tags)
                      ? item.tags.slice(0, 2).map((tag) => (
                          <Tag key={`${item.id}:${tag}`} color="default">
                            {tag}
                          </Tag>
                        ))
                      : null}
                  </Space>
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );

  const renderOrefAlertsPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.oref.title", { defaultValue: "OREF Alerts" })}</span>
          <Tag color="geekblue">{orefAlerts?.alerts?.length ?? 0}</Tag>
          <Tag color="purple">
            {t("situationMonitor.oref.history24h", {
              defaultValue: "24h {{count}}",
              count: orefAlerts?.historyCount24h ?? orefHistory?.historyCount24h ?? 0,
            })}
          </Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={signalsLoading.oref && !orefAlerts}
    >
      {orefAlerts?.error ? <Alert type="warning" showIcon message={orefAlerts.error} /> : null}
      {!orefAlerts ? (
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading" })}
        </Typography.Text>
      ) : !orefAlerts.configured ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.oref.configHint", {
            defaultValue: "Configure OREF proxy auth and enable OREF polling in environment variables.",
          })}
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {orefAlerts.alerts.length === 0 ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.oref.empty", { defaultValue: "No active OREF alerts." })}
            </Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={orefAlerts.alerts.slice(0, orefAlertsPerPanel)}
              renderItem={(alert) => (
                <List.Item key={alert.id}>
                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                    <Space size={8} wrap>
                      <Tag color="red">{alert.cat || "alert"}</Tag>
                      <Typography.Text>{alert.title}</Typography.Text>
                    </Space>
                    {Array.isArray(alert.data) && alert.data.length > 0 ? (
                      <Typography.Text type="secondary">
                        {alert.data.slice(0, 4).join(" · ")}
                      </Typography.Text>
                    ) : null}
                    {alert.alertDate ? (
                      <Typography.Text type="secondary">{alert.alertDate}</Typography.Text>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          )}

          {orefHistory?.history?.length ? (
            <>
              <Divider style={{ margin: "8px 0" }} />
              <Typography.Text type="secondary">
                {t("situationMonitor.oref.recentWaves", { defaultValue: "Recent waves" })}
              </Typography.Text>
              <List
                size="small"
                dataSource={[...orefHistory.history].reverse().slice(0, orefHistoryPerPanel)}
                renderItem={(entry) => {
                  const date = entry.timestamp ? new Date(entry.timestamp) : null;
                  const waveCount = (entry.alerts ?? []).reduce((sum, item) => {
                    const count = Array.isArray(item.data) && item.data.length > 0 ? item.data.length : 1;
                    return sum + count;
                  }, 0);
                  return (
                    <List.Item key={entry.timestamp}>
                      <Space size={8} wrap>
                        <Tag color="default">{waveCount}</Tag>
                        {date && !Number.isNaN(date.getTime()) ? (
                          <Typography.Text type="secondary">
                            {formatDateTime(date, locale, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </Typography.Text>
                        ) : (
                          <Typography.Text type="secondary">{entry.timestamp}</Typography.Text>
                        )}
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </>
          ) : null}
        </Space>
      )}
    </Card>
  );

  const renderMapPanel = () => (
    <Card
      title={t("situationMonitor.map.title", { defaultValue: "Global Map" })}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      styles={{ body: { padding: 0, overflow: "hidden" } }}
    >
      <WarMap className="h-full" translateTarget={translateToZh ? "zh-CN" : undefined} />
    </Card>
  );

  const renderCorrelationPanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>{t("situationMonitor.correlation.title", { defaultValue: "Correlation Engine" })}</span>
          <Tag color="geekblue">
            {(translateToZh
              ? data?.correlationSummary?.statusZh ?? data?.correlationSummary?.status
              : data?.correlationSummary?.status) ?? t("common.loading", { defaultValue: "Loading" })}
          </Tag>
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            onClick={() => {
              setFeedbackDrawerOpen(true);
              void loadSignalCatalog();
            }}
          >
            {t("situationMonitor.narrative.reportMissed", { defaultValue: "Report missed" })}
          </Button>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Row gutter={[12, 12]}>
        <Col span={24}>
          <Typography.Text type="secondary">
            {t("situationMonitor.correlation.hint", {
              defaultValue:
                "Pattern-based correlation across titles/summary (momentum uses a short Redis history window; feedback updates matching/suppression).",
            })}
          </Typography.Text>
        </Col>
        <Col span={24}>
          <Table
            rowKey="id"
            size="small"
            columns={emergingColumns}
            expandable={correlationExpandable}
            dataSource={data?.correlation?.emergingPatterns ?? []}
            pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.crossSourceTitle", { defaultValue: "Cross-source" })}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={crossSourceColumns}
            expandable={correlationExpandable}
            dataSource={data?.correlation?.crossSourceCorrelations ?? []}
            pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.momentumTitle", { defaultValue: "Momentum" })}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={momentumColumns}
            expandable={correlationExpandable}
            dataSource={data?.correlation?.momentumSignals ?? []}
            pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.predictiveTitle", { defaultValue: "Predictive" })}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={predictiveColumns}
            expandable={correlationExpandable}
            dataSource={data?.correlation?.predictiveSignals ?? []}
            pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
          />
        </Col>
      </Row>
    </Card>
  );

  const renderNarrativePanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>{t("situationMonitor.narrative.title", { defaultValue: "Narrative Tracker" })}</span>
          <Tag color="geekblue">
            {(translateToZh
              ? data?.narrativeSummary?.statusZh ?? data?.narrativeSummary?.status
              : data?.narrativeSummary?.status) ?? t("common.loading", { defaultValue: "Loading" })}
          </Tag>
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            onClick={() => {
              setFeedbackDrawerOpen(true);
              void loadSignalCatalog();
            }}
          >
            {t("situationMonitor.narrative.reportMissed", { defaultValue: "Report missed" })}
          </Button>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Typography.Text type="secondary">
        {t("situationMonitor.narrative.hint", {
          defaultValue:
            "Narrative propagation model: cross-source radar, fringe→mainstream path, credibility & citation chain (with continuous learning from feedback).",
        })}
      </Typography.Text>
      <div className="mt-3">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.crossing", { defaultValue: "Crossing" })}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.fringeToMainstream ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
      <div className="mt-5">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.emerging", { defaultValue: "Emerging" })}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.emergingFringe ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
      <div className="mt-5">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.watch", { defaultValue: "Watchlist" })}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.narrativeWatch ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
      <div className="mt-5">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.disinfo", { defaultValue: "Disinfo" })}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.disinfoSignals ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
    </Card>
  );

  const renderMainCharacterPanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>{t("situationMonitor.mainCharacter.title", { defaultValue: "Main Character" })}</span>
          <Tag color="geekblue">
            {(translateToZh
              ? data?.mainCharacterSummary?.statusZh ?? data?.mainCharacterSummary?.status
              : data?.mainCharacterSummary?.status) ?? t("common.empty", { defaultValue: "No data" })}
          </Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Table
        rowKey="name"
        size="small"
        columns={mainCharacterColumns}
        dataSource={data?.mainCharacter?.characters ?? []}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
      />
    </Card>
  );

  const renderLiveNewsPanel = () => <SituationMonitorLiveNewsPanel />;
  const renderLiveWebcamsPanel = () => <SituationMonitorLiveWebcamsPanel />;
  const renderMonitorsPanel = () => <SituationMonitorMonitorsPanel />;

  const renderPanel = (panelId: SituationMonitorPanelId) => {
    switch (panelId) {
      case "map":
        return renderMapPanel();
      case "feeds-politics":
        return renderFeedPanel("politics");
      case "feeds-tech":
        return renderFeedPanel("tech");
      case "feeds-finance":
        return renderFeedPanel("finance");
      case "feeds-gov":
        return renderFeedPanel("gov");
      case "feeds-ai":
        return renderFeedPanel("ai");
      case "feeds-intel":
        return renderFeedPanel("intel");
      case "alerts":
        return renderAlertsPanel();
      case "telegram-feed":
        return renderTelegramFeedPanel();
      case "oref-alerts":
        return renderOrefAlertsPanel();
      case "markets":
        return renderMarketsPanel();
      case "crypto":
        return renderCryptoPanel();
      case "fed":
        return renderFedPanel();
      case "leaders":
        return renderLeadersPanel();
      case "situation-venezuela":
        return renderSituationPanel(
          "venezuela",
          t("situationMonitor.situations.venezuela", { defaultValue: "Venezuela Watch" }),
        );
      case "situation-greenland":
        return renderSituationPanel(
          "greenland",
          t("situationMonitor.situations.greenland", { defaultValue: "Greenland Watch" }),
        );
      case "situation-iran":
        return renderSituationPanel(
          "iran",
          t("situationMonitor.situations.iran", { defaultValue: "Iran Crisis" }),
        );
      case "correlation":
        return renderCorrelationPanel();
      case "narrative":
        return renderNarrativePanel();
      case "main-character":
        return renderMainCharacterPanel();
      case "live-news":
        return renderLiveNewsPanel();
      case "live-webcams":
        return renderLiveWebcamsPanel();
      case "monitors":
        return renderMonitorsPanel();
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.situationMonitor.title", { defaultValue: "Situation Monitor" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.situationMonitor.subtitle", {
            defaultValue: "Correlation, narratives, and key figures across your recent items."
          })}
        </Typography.Text>

        <Space wrap align="center" style={{ width: "100%" }}>
          <Select
            value={windowHours}
            onChange={(value) => setWindowHours(value)}
            options={[
              { label: t("situationMonitor.window.6h", { defaultValue: "Last 6h" }), value: 6 },
              { label: t("situationMonitor.window.24h", { defaultValue: "Last 24h" }), value: 24 },
              { label: t("situationMonitor.window.72h", { defaultValue: "Last 72h" }), value: 72 },
            ]}
            style={{ width: 160 }}
          />
          <Select
            value={scope}
            onChange={(value) => setScope(value)}
            options={[
              { label: t("situationMonitor.scope.tagged", { defaultValue: "Tagged sources" }), value: "tagged" },
              { label: t("situationMonitor.scope.all", { defaultValue: "All items" }), value: "all" },
            ]}
            style={{ width: 160 }}
          />
          <Button onClick={() => void load()} loading={loading}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => setPanelsOpen(true)}>
            {t("situationMonitor.panels.title", { defaultValue: "Panels" })}
          </Button>
          {session?.accessToken ? (
            <Space size={6} align="center">
              {uiSync.state === "error" ? (
                uiSync.lastErrorMessage ? (
                  <Popover content={uiSync.lastErrorMessage}>
                    <Tag color="red">{t("common.syncError", { defaultValue: "ERROR" })}</Tag>
                  </Popover>
                ) : (
                  <Tag color="red">{t("common.syncError", { defaultValue: "ERROR" })}</Tag>
                )
              ) : uiSync.state === "syncing" ? (
                <Tag color="processing">{t("common.syncing", { defaultValue: "SYNCING" })}</Tag>
              ) : uiSync.state === "loading" ? (
                <Tag color="processing">{t("common.loading", { defaultValue: "LOADING" })}</Tag>
              ) : (
                <Tag color="green">{t("common.synced", { defaultValue: "SYNCED" })}</Tag>
              )}
              {uiSync.state === "error" ? (
                <Button size="small" onClick={() => requestUiSyncReload()}>
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              ) : null}
            </Space>
          ) : null}
          {session?.accessToken ? (
            <Space size={6} align="center">
              <Tag color={realtimeState.connected ? "green" : "default"}>
                {realtimeState.connected
                  ? t("situationMonitor.realtime.connected", { defaultValue: "RT ON" })
                  : t("situationMonitor.realtime.disconnected", { defaultValue: "RT OFF" })}
              </Tag>
              {!realtimeState.connected && realtimeState.error ? (
                <Popover content={realtimeState.error}>
                  <Tag color="orange">
                    {t("situationMonitor.realtime.error", { defaultValue: "RT ERROR" })}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
          ) : null}
          <Space size={8} align="center">
            <Switch checked={autoRefresh} onChange={(checked) => setAutoRefresh(checked)} />
            <Typography.Text type="secondary">
              {t("situationMonitor.autoRefresh", { defaultValue: "Auto refresh" })}
            </Typography.Text>
          </Space>
          <Space size={8} align="center">
            <Switch checked={translateToZh} onChange={(checked) => setTranslateToZh(checked)} />
            <Typography.Text type="secondary">
              {t("situationMonitor.translateToZh", { defaultValue: "Translate to Simplified Chinese" })}
            </Typography.Text>
          </Space>
          {translateToZh && data?.translation && !data.translation.applied ? (
            data.translation.error ? (
              <Popover content={data.translation.error}>
                <Tag color="red">{t("situationMonitor.translateError", { defaultValue: "TRANSLATION ERROR" })}</Tag>
              </Popover>
            ) : (
              <Tag color="red">{t("situationMonitor.translateError", { defaultValue: "TRANSLATION ERROR" })}</Tag>
            )
          ) : null}
          {updatedAt ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.updatedAt", {
                defaultValue: "Updated: {{time}}",
                time: formatDateTime(updatedAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                }),
              })}
            </Typography.Text>
          ) : null}
          {refreshStage !== "idle" ? (
            <Tag color="processing">
              {refreshStage === "core"
                ? t("situationMonitor.refresh.core", { defaultValue: "Refreshing core" })
                : t("situationMonitor.refresh.external", { defaultValue: "Loading external" })}
            </Tag>
          ) : null}
          {typeof data?.analyzedItems === "number" ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.sampleSize", {
                defaultValue: "Analyzed: {{count}}",
                count: data.analyzedItems,
              })}
            </Typography.Text>
          ) : null}
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {feedbackNotice ? (
        <div className="mt-3">
          <Alert
            showIcon
            type={feedbackNotice.type}
            message={feedbackNotice.message}
            closable
            onClose={() => setFeedbackNotice(null)}
            action={
              feedbackNotice.type === "success" ? (
                <Button size="small" onClick={() => void load({ includeExternal: false })}>
                  {t("common.refresh", { defaultValue: "Refresh" })}
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}

      <Drawer
        title={t("situationMonitor.panels.title", { defaultValue: "Panels" })}
        open={panelsOpen}
        onClose={() => setPanelsOpen(false)}
        width={screens.sm ? 360 : "100%"}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {canEditLayout
              ? t("situationMonitor.panels.hint", {
                  defaultValue: "Drag cards by their headers to rearrange the dashboard.",
                })
              : t("situationMonitor.panels.hintReadonly", {
                  defaultValue: "Panel reordering is available on wider screens.",
                })}
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space size={8} wrap>
              <Typography.Text>{t("situationMonitor.presets.title", { defaultValue: "Presets" })}</Typography.Text>
              {activePreset ? (
                <Tag color="geekblue">
                  {activePreset.nameKey ? t(activePreset.nameKey, { defaultValue: activePreset.name }) : activePreset.name}
                </Tag>
              ) : (
                <Tag color="default">{t("situationMonitor.presets.custom", { defaultValue: "Custom" })}</Tag>
              )}
            </Space>
            <Space size={8} wrap>
              <Switch checked={resetLayoutOnPreset} onChange={(checked) => setResetLayoutOnPreset(checked)} />
              <Typography.Text type="secondary">
                {t("situationMonitor.presets.resetLayout", {
                  defaultValue: "Reset layout when applying",
                })}
              </Typography.Text>
            </Space>
            <List
              size="small"
              dataSource={SITUATION_MONITOR_PRESETS.slice()}
              renderItem={(preset) => (
                <List.Item
                  actions={[
                    <Button
                      key={preset.id}
                      size="small"
                      onClick={() => applyPreset(preset.id, { resetLayout: resetLayoutOnPreset })}
                    >
                      {t("common.apply", { defaultValue: "Apply" })}
                    </Button>,
                  ]}
                >
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      {preset.nameKey ? t(preset.nameKey, { defaultValue: preset.name }) : preset.name}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {preset.descriptionKey
                        ? t(preset.descriptionKey, { defaultValue: preset.description })
                        : preset.description}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Space>
          <Space wrap>
            <Button onClick={() => resetPanels()}>
              {t("situationMonitor.panels.reset", { defaultValue: "Reset panels" })}
            </Button>
          </Space>
          <List
            size="small"
            dataSource={SITUATION_MONITOR_PANELS.slice()}
            renderItem={(panel) => (
              <List.Item
                actions={[
                  <Switch
                    key={panel.id}
                    checked={visibility[panel.id]}
                    onChange={(checked) => setPanelVisible(panel.id, checked)}
                  />,
                ]}
              >
                <Space size={8}>
                  <Typography.Text>
                    {panel.titleKey ? t(panel.titleKey, { defaultValue: panel.title }) : panel.title}
                  </Typography.Text>
                  {panel.locked ? (
                    <Tag color="default">
                      {t("situationMonitor.panels.fixed", { defaultValue: "Fixed" })}
                    </Tag>
                  ) : null}
                </Space>
              </List.Item>
            )}
          />
        </Space>
      </Drawer>

      <Drawer
        title={t("situationMonitor.narrative.reportMissed", { defaultValue: "Report missed" })}
        open={feedbackDrawerOpen}
        onClose={() => setFeedbackDrawerOpen(false)}
        width={screens.md ? 420 : "100%"}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("situationMonitor.narrative.reportMissedHint", {
              defaultValue: "Pick a headline that should have triggered a narrative/correlation signal, then choose the expected signal.",
            })}
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>{t("situationMonitor.narrative.missedHeadline", { defaultValue: "Headline" })}</Typography.Text>
            <Select
              showSearch
              value={missedHeadlineId || undefined}
              placeholder={t("situationMonitor.narrative.missedHeadlinePlaceholder", { defaultValue: "Select a headline" })}
              options={feedbackCandidateHeadlines.map((headline) => ({
                value: headline.id,
                label: `${headline.source} · ${translateToZh ? headline.titleZh ?? headline.title : headline.title}`,
              }))}
              filterOption={(input, option) =>
                String(option?.label ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={(value) => setMissedHeadlineId(value)}
            />
          </Space>
          {missedHeadlineId && feedbackHeadlineById.has(missedHeadlineId) ? (
            <Card size="small" styles={{ body: { padding: 12 } }}>
              {(() => {
                const headline = feedbackHeadlineById.get(missedHeadlineId);
                if (!headline) return null;
                const href = headline.link ? safeHttpUrl(headline.link) : null;
                const title = translateToZh ? headline.titleZh ?? headline.title : headline.title;
                const date = Number.isFinite(headline.timestamp) ? new Date(headline.timestamp) : null;
                return (
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    {href ? (
                      <Typography.Link href={href} target="_blank" rel="noreferrer">
                        {title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>{title}</Typography.Text>
                    )}
                    <Space size={8} wrap>
                      <Typography.Text type="secondary">{headline.source}</Typography.Text>
                      {date ? (
                        <Typography.Text type="secondary">
                          {formatDateTime(date, locale, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Typography.Text>
                      ) : null}
                      <Tag color="blue">{categoryLabels[headline.category]}</Tag>
                    </Space>
                    {renderHeadlineSummary(headline)}
                  </Space>
                );
              })()}
            </Card>
          ) : null}
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>{t("situationMonitor.narrative.missedSignalType", { defaultValue: "Signal type" })}</Typography.Text>
            <Select
              value={missedSignalType}
              options={[
                { value: "narrative", label: t("situationMonitor.narrative.title", { defaultValue: "Narrative" }) },
                { value: "correlation", label: t("situationMonitor.correlation.title", { defaultValue: "Correlation" }) },
              ]}
              onChange={(value) => {
                setMissedSignalType(value as "narrative" | "correlation");
                setMissedSignalId("");
              }}
            />
          </Space>
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>{t("situationMonitor.narrative.missedSignal", { defaultValue: "Expected signal" })}</Typography.Text>
            <Select
              showSearch
              loading={catalogLoading}
              value={missedSignalId || undefined}
              placeholder={t("situationMonitor.narrative.missedSignalPlaceholder", { defaultValue: "Select a signal" })}
              options={
                (missedSignalType === "narrative" ? signalCatalog?.narratives : signalCatalog?.correlations)?.map(
                  (entry) => ({
                    value: entry.id,
                    label: `${entry.name} · ${entry.category}`,
                  }),
                ) ?? []
              }
              filterOption={(input, option) =>
                String(option?.label ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={(value) => setMissedSignalId(value)}
            />
          </Space>
          <Space>
            <Button
              type="primary"
              disabled={!missedHeadlineId || !missedSignalId}
              onClick={() => {
                const headline = missedHeadlineId ? feedbackHeadlineById.get(missedHeadlineId) : undefined;
                if (!headline) {
                  return;
                }
                void submitSignalFeedback({
                  signalType: missedSignalType,
                  signalId: missedSignalId,
                  label: "false_negative",
                  item: {
                    itemMetaId: headline.itemMetaId,
                    title: headline.title,
                    source: headline.source,
                    link: headline.link,
                  },
                });
                setFeedbackDrawerOpen(false);
                setMissedHeadlineId("");
                setMissedSignalId("");
              }}
            >
              {t("common.submit", { defaultValue: "Submit" })}
            </Button>
            <Button
              onClick={() => {
                setFeedbackDrawerOpen(false);
              }}
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>
          </Space>
        </Space>
      </Drawer>

      {visiblePanels.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("situationMonitor.panels.none", { defaultValue: "No panels enabled. Open Panels to re-enable." })}
        />
      ) : (
        <ResponsiveGridLayout
          className="layout"
          layouts={gridLayouts}
          breakpoints={GRID_BREAKPOINTS}
          cols={GRID_COLS}
          rowHeight={30}
          isResizable={canEditLayout}
          isDraggable={canEditLayout}
          margin={gridMargin}
          draggableHandle=".ant-card-head"
          onBreakpointChange={(nextBreakpoint: string) => handleGridBreakpointChange(nextBreakpoint)}
          onDragStop={(nextLayout: Layout[]) => {
            handleLayoutChange(nextLayout);
          }}
          onResizeStop={(nextLayout: Layout[]) => {
            handleLayoutChange(nextLayout);
          }}
        >
          {visiblePanels.map((panel) => (
            <div key={panel.id}>{renderPanel(panel.id)}</div>
          ))}
        </ResponsiveGridLayout>
      )}

      {/*
      <Row gutter={[16, 16]}>
        {feedCategories.map((category) => {
          const entries = data?.headlines?.[category] ?? [];
          return (
            <Col xs={24} md={12} xl={8} key={category}>
              <Card
                title={
                  <Space size={10}>
                    <span>{categoryLabels[category]}</span>
                    <Tag color="geekblue">{entries.length}</Tag>
                  </Space>
                }
                className="glass-panel border border-[var(--border)]"
                size="small"
                loading={loading && !data}
              >
                {entries.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.feeds.empty", { defaultValue: "No headlines yet." })}
                  </Typography.Text>
                ) : (
                  <List
                    size="small"
                    dataSource={entries.slice(0, feedItemsPerCategory)}
                    renderItem={(entry) => {
                      const href = entry.link ? safeHttpUrl(entry.link) : null;
                      const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
                      return (
                        <List.Item key={entry.id}>
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            <Space size={8} wrap>
                              {entry.isAlert ? (
                                <Tag color="red">{t("situationMonitor.feeds.alert", { defaultValue: "ALERT" })}</Tag>
                              ) : null}
                              {entry.origin === "gdelt" ? <Tag color="purple">GDELT</Tag> : null}
                              {href ? (
                                <Typography.Link href={href} target="_blank" rel="noreferrer">
                                  {entry.title}
                                </Typography.Link>
                              ) : (
                                <Typography.Text>{entry.title}</Typography.Text>
                              )}
                            </Space>
                            <Space size={8} wrap>
                              <Typography.Text type="secondary">{entry.source}</Typography.Text>
                              {date ? (
                                <Typography.Text type="secondary">
                                  {formatDateTime(date, locale, {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </Typography.Text>
                              ) : null}
                              {entry.alertKeyword ? (
                                <Typography.Text type="secondary">{entry.alertKeyword}</Typography.Text>
                              ) : null}
                            </Space>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                )}
              </Card>
            </Col>
          );
        })}
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card
            title={
              <Space size={10}>
                <span>{t("situationMonitor.alerts.title", { defaultValue: "Alerts" })}</span>
                <Tag color="geekblue">{data?.alerts?.length ?? 0}</Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            {data?.alerts?.length ? (
              <List
                size="small"
                dataSource={data.alerts.slice(0, alertsPerPanel)}
                renderItem={(entry) => {
                  const href = entry.link ? safeHttpUrl(entry.link) : null;
                  const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
                  return (
                    <List.Item key={entry.id}>
                      <Space direction="vertical" size={2} style={{ width: "100%" }}>
                        <Space size={8} wrap>
                          <Tag color={entry.severity === "critical" ? "red" : "orange"}>
                            {entry.severity.toUpperCase()}
                          </Tag>
                          <Tag color="blue">{categoryLabels[entry.category]}</Tag>
                          {href ? (
                            <Typography.Link href={href} target="_blank" rel="noreferrer">
                              {entry.title}
                            </Typography.Link>
                          ) : (
                            <Typography.Text>{entry.title}</Typography.Text>
                          )}
                        </Space>
                        <Space size={8} wrap>
                          <Typography.Text type="secondary">{entry.source}</Typography.Text>
                          {date ? (
                            <Typography.Text type="secondary">
                              {formatDateTime(date, locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                            </Typography.Text>
                          ) : null}
                          {entry.alertKeyword ? (
                            <Typography.Text type="secondary">{entry.alertKeyword}</Typography.Text>
                          ) : null}
                        </Space>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            ) : (
              <Typography.Text type="secondary">
                {t("situationMonitor.alerts.empty", { defaultValue: "No alerts in the current window." })}
              </Typography.Text>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            title={
              <Space size={10}>
                <span>{t("situationMonitor.markets.title", { defaultValue: "Markets" })}</span>
                {marketsSnapshot && !marketsSnapshot.hasFinnhubApiKey ? (
                  <Tag color="default">{t("situationMonitor.markets.missingKey", { defaultValue: "API key needed" })}</Tag>
                ) : null}
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            {marketsSnapshot?.error ? <Alert type="warning" showIcon message={marketsSnapshot.error} /> : null}
            {marketsSnapshot ? (
              !marketsSnapshot.hasFinnhubApiKey ? (
                <Typography.Text type="secondary">
                  {t("situationMonitor.markets.hint", {
                    defaultValue: "Configure Finnhub API key in Admin Settings > System Settings > Situation Monitor.",
                  })}
                </Typography.Text>
              ) : (
              <>
                <Table
                  rowKey="symbol"
                  size="small"
                  pagination={false}
                  columns={[
                    { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                    {
                      title: t("situationMonitor.markets.price", { defaultValue: "Price" }),
                      dataIndex: "price",
                      key: "price",
                      width: 120,
                      render: (value: number) => formatUsd(value, locale),
                    },
                    {
                      title: t("situationMonitor.markets.changePct", { defaultValue: "Change" }),
                      dataIndex: "changePercent",
                      key: "changePercent",
                      width: 110,
                      render: (value: number) => (
                        <Typography.Text type={Number.isFinite(value) && value < 0 ? "danger" : "success"}>
                          {formatPercent(value)}
                        </Typography.Text>
                      ),
                    },
                  ]}
                  dataSource={(marketsSnapshot.indices ?? []).slice(0, 4)}
                />
                <Divider style={{ margin: "12px 0" }} />
                <Table
                  rowKey="symbol"
                  size="small"
                  pagination={false}
                  columns={[
                    { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                    {
                      title: t("situationMonitor.markets.price", { defaultValue: "Price" }),
                      dataIndex: "price",
                      key: "price",
                      width: 120,
                      render: (value: number) => formatUsd(value, locale),
                    },
                    {
                      title: t("situationMonitor.markets.changePct", { defaultValue: "Change" }),
                      dataIndex: "changePercent",
                      key: "changePercent",
                      width: 110,
                      render: (value: number) => (
                        <Typography.Text type={Number.isFinite(value) && value < 0 ? "danger" : "success"}>
                          {formatPercent(value)}
                        </Typography.Text>
                      ),
                    },
                  ]}
                  dataSource={(marketsSnapshot.commodities ?? []).slice(0, 3)}
                />
              </>
              )
            ) : (
              <Typography.Text type="secondary">
                {refreshStage === "external"
                  ? t("common.loading", { defaultValue: "Loading" })
                  : t("situationMonitor.markets.empty", { defaultValue: "No markets data yet." })}
              </Typography.Text>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            title={
              <Space size={10}>
                <span>{t("situationMonitor.crypto.title", { defaultValue: "Crypto" })}</span>
                <Tag color="geekblue">{data?.crypto?.length ?? 0}</Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            {data?.crypto?.length ? (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                columns={[
                  { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                  {
                    title: t("situationMonitor.crypto.price", { defaultValue: "Price" }),
                    dataIndex: "currentPriceUsd",
                    key: "currentPriceUsd",
                    width: 130,
                    render: (value: number) => formatUsd(value, locale),
                  },
                  {
                    title: t("situationMonitor.crypto.change24h", { defaultValue: "24h" }),
                    dataIndex: "change24hPercent",
                    key: "change24hPercent",
                    width: 110,
                    render: (value: number) => (
                      <Typography.Text type={Number.isFinite(value) && value < 0 ? "danger" : "success"}>
                        {formatPercent(value)}
                      </Typography.Text>
                    ),
                  },
                ]}
                dataSource={data.crypto}
              />
            ) : (
              <Typography.Text type="secondary">
                {t("situationMonitor.crypto.empty", { defaultValue: "No crypto data." })}
              </Typography.Text>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space size={10}>
                <span>{t("situationMonitor.fed.title", { defaultValue: "Federal Reserve" })}</span>
                {fedSnapshot && !fedSnapshot.hasFredApiKey ? <Tag color="default">FRED API</Tag> : null}
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            {!fedSnapshot ? (
              <Typography.Text type="secondary">
                {refreshStage === "external"
                  ? t("common.loading", { defaultValue: "Loading" })
                  : t("situationMonitor.fed.empty", { defaultValue: "No Federal Reserve data yet." })}
              </Typography.Text>
            ) : (
              <>
                {fedSnapshot.error ? <Alert type="warning" showIcon message={fedSnapshot.error} /> : null}
                {!fedSnapshot.hasFredApiKey ? (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.fed.hint", {
                      defaultValue: "Configure FRED API key in Admin Settings > System Settings > Situation Monitor.",
                    })}
                  </Typography.Text>
                ) : fedSnapshot.indicators?.length ? (
                  <Table
                    rowKey="seriesId"
                    size="small"
                    pagination={false}
                    columns={[
                      { title: t("common.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
                      {
                        title: t("situationMonitor.fed.value", { defaultValue: "Value" }),
                        dataIndex: "value",
                        key: "value",
                        width: 110,
                        render: (value: number | null, record: SituationMonitorFedIndicator) =>
                          value === null ? "—" : `${value.toFixed(2)}${record.unit}`,
                      },
                      {
                        title: t("situationMonitor.fed.delta", { defaultValue: "Δ" }),
                        dataIndex: "change",
                        key: "change",
                        width: 90,
                        render: (value: number | null) =>
                          value === null ? (
                            "—"
                          ) : (
                            <Typography.Text type={value < 0 ? "danger" : "success"}>
                              {value > 0 ? "+" : ""}
                              {value.toFixed(2)}
                            </Typography.Text>
                          ),
                      },
                    ]}
                    dataSource={fedSnapshot.indicators}
                  />
                ) : null}

                {fedSnapshot.moneyPrinter ? (
                  <>
                    <Divider style={{ margin: "12px 0" }} />
                    <Space direction="vertical" size={6} style={{ width: "100%" }}>
                      <Space size={10} wrap>
                        <Tag color={fedSnapshot.moneyPrinter.changeTrillions > 0 ? "green" : "red"}>
                          {fedSnapshot.moneyPrinter.changeTrillions > 0 ? "PRINTER ON" : "PRINTER OFF"}
                        </Tag>
                        <Typography.Text type="secondary">
                          {t("situationMonitor.fed.balanceSheet", { defaultValue: "Balance sheet" })}:{" "}
                          {fedSnapshot.moneyPrinter.valueTrillions.toFixed(2)}T
                        </Typography.Text>
                        <Typography.Text type={fedSnapshot.moneyPrinter.changePercent < 0 ? "danger" : "success"}>
                          {fedSnapshot.moneyPrinter.changeTrillions > 0 ? "+" : ""}
                          {(fedSnapshot.moneyPrinter.changeTrillions * 1000).toFixed(0)}B (
                          {fedSnapshot.moneyPrinter.changePercent > 0 ? "+" : ""}
                          {fedSnapshot.moneyPrinter.changePercent.toFixed(2)}%)
                        </Typography.Text>
                      </Space>
                      <Progress
                        percent={Math.min(100, Math.max(0, fedSnapshot.moneyPrinter.percentOfMax))}
                        showInfo={false}
                      />
                    </Space>
                  </>
                ) : null}

                {fedSnapshot.news?.length ? (
                  <>
                    <Divider style={{ margin: "12px 0" }} />
                    <List
                      size="small"
                      dataSource={fedSnapshot.news.slice(0, fedNewsPerPanel)}
                      renderItem={(item) => {
                        const href = item.link ? safeHttpUrl(item.link) : null;
                        const date = Number.isFinite(item.timestamp) ? new Date(item.timestamp) : null;
                        return (
                          <List.Item key={item.id}>
                            <Space direction="vertical" size={2} style={{ width: "100%" }}>
                              <Space size={8} wrap>
                                <Tag color={item.type === "powell" ? "orange" : "blue"}>
                                  {translateToZh ? item.typeLabelZh ?? item.typeLabel : item.typeLabel}
                                </Tag>
                                {item.hasVideo ? <Tag color="purple">VIDEO</Tag> : null}
                                {href ? (
                                  <Typography.Link href={href} target="_blank" rel="noreferrer">
                                    {item.title}
                                  </Typography.Link>
                                ) : (
                                  <Typography.Text>{item.title}</Typography.Text>
                                )}
                              </Space>
                              <Space size={8} wrap>
                                {date ? (
                                  <Typography.Text type="secondary">
                                    {formatDateTime(date, locale, {
                                      month: "2-digit",
                                      day: "2-digit",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </Typography.Text>
                                ) : null}
                                {item.isPowellRelated && item.type !== "powell" ? <Tag color="orange">POWELL</Tag> : null}
                              </Space>
                            </Space>
                          </List.Item>
                        );
                      }}
                    />
                  </>
                ) : null}
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            title={
              <Space size={10}>
                <span>{t("situationMonitor.leaders.title", { defaultValue: "World Leaders" })}</span>
                <Tag color="geekblue">{data?.leaders?.length ?? 0}</Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            <Table
              rowKey="id"
              size="small"
              pagination={{ pageSize: screens.lg ? 8 : 6, hideOnSinglePage: true }}
              columns={[
                {
                  title: t("situationMonitor.leaders.leader", { defaultValue: "Leader" }),
                  dataIndex: "name",
                  key: "name",
                  render: (_: string, record: SituationMonitorWorldLeader) => (
                    <Space size={8}>
                      {record.flag ? <span>{record.flag}</span> : null}
                      <span>{record.name}</span>
                      <Typography.Text type="secondary">{record.country}</Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: t("situationMonitor.leaders.mentions", { defaultValue: "Mentions" }),
                  dataIndex: "matchCount",
                  key: "matchCount",
                  width: 110,
                },
                {
                  title: t("situationMonitor.leaders.sample", { defaultValue: "Sample" }),
                  dataIndex: "headlines",
                  key: "headlines",
                  render: (value: SituationMonitorWorldLeader["headlines"]) => {
                    const first = Array.isArray(value) ? value[0] : undefined;
                    const href = first?.link ? safeHttpUrl(first.link) : null;
                    if (!first) return <Typography.Text type="secondary">—</Typography.Text>;
                    const title = translateToZh ? first.titleZh ?? first.title : first.title;
                    return href ? (
                      <Typography.Link href={href} target="_blank" rel="noreferrer">
                        {title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>{title}</Typography.Text>
                    );
                  },
                },
              ]}
              dataSource={(data?.leaders ?? []).filter((leader) => leader.matchCount > 0)}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {(data?.situations ?? []).map((panel) => (
          <Col xs={24} md={8} key={panel.id}>
            <Card
              title={
                <Space size={10}>
                  <span>{panel.title}</span>
                  <Tag color={panel.level === "critical" ? "red" : panel.level === "elevated" ? "orange" : "default"}>
                    {panel.status}
                  </Tag>
                </Space>
              }
              className="glass-panel border border-[var(--border)]"
              loading={loading && !data}
            >
              <Typography.Text type="secondary">{panel.subtitle}</Typography.Text>
              <div className="mt-3">
                {panel.headlines.length ? (
                  <List
                    size="small"
                    dataSource={panel.headlines.slice(0, 6)}
                    renderItem={(entry, index) => {
                      const key = `${panel.id}-${index}`;
                      const href = entry.link ? safeHttpUrl(entry.link) : null;
                      const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
                      return (
                        <List.Item key={key}>
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            {href ? (
                              <Typography.Link href={href} target="_blank" rel="noreferrer">
                                {entry.title}
                              </Typography.Link>
                            ) : (
                              <Typography.Text>{entry.title}</Typography.Text>
                            )}
                            <Space size={8} wrap>
                              <Typography.Text type="secondary">{entry.source}</Typography.Text>
                              {date ? (
                                <Typography.Text type="secondary">
                                  {formatDateTime(date, locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                </Typography.Text>
                              ) : null}
                            </Space>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                ) : (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.situations.empty", { defaultValue: "No recent headlines." })}
                  </Typography.Text>
                )}
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={t("situationMonitor.map.title", { defaultValue: "Global Map" })}
            className="glass-panel border border-[var(--border)]"
          >
            <WarMap />
          </Card>

          <Card
            title={
              <Space size={12}>
                <span>{t("situationMonitor.correlation.title", { defaultValue: "Correlation Engine" })}</span>
                <Tag color="geekblue">
                  {(translateToZh
                    ? data?.correlationSummary?.statusZh ?? data?.correlationSummary?.status
                    : data?.correlationSummary?.status) ?? t("common.loading", { defaultValue: "Loading" })}
                </Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)] mt-4"
            loading={loading && !data}
          >
            <Row gutter={[12, 12]}>
              <Col span={24}>
                <Typography.Text type="secondary">
                  {t("situationMonitor.correlation.hint", {
                    defaultValue: "Pattern-based correlation across titles (momentum uses a short Redis history window).",
                  })}
                </Typography.Text>
              </Col>
              <Col span={24}>
                <Table
                  rowKey="id"
                  size="small"
                  columns={emergingColumns}
                  dataSource={data?.correlation?.emergingPatterns ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
              <Col span={24}>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  {t("situationMonitor.correlation.crossSourceTitle", { defaultValue: "Cross-source" })}
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  columns={crossSourceColumns}
                  dataSource={data?.correlation?.crossSourceCorrelations ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
              <Col span={24}>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  {t("situationMonitor.correlation.momentumTitle", { defaultValue: "Momentum" })}
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  columns={momentumColumns}
                  dataSource={data?.correlation?.momentumSignals ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
              <Col span={24}>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  {t("situationMonitor.correlation.predictiveTitle", { defaultValue: "Predictive" })}
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  columns={predictiveColumns}
                  dataSource={data?.correlation?.predictiveSignals ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
            </Row>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            title={
              <Space size={12}>
                <span>{t("situationMonitor.narrative.title", { defaultValue: "Narrative Tracker" })}</span>
                <Tag color="geekblue">
                  {(translateToZh
                    ? data?.narrativeSummary?.statusZh ?? data?.narrativeSummary?.status
                    : data?.narrativeSummary?.status) ?? t("common.loading", { defaultValue: "Loading" })}
                </Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            <Typography.Text type="secondary">
              {t("situationMonitor.narrative.hint", {
                defaultValue: "Keyword-based narratives and fringe-to-mainstream crossover signals.",
              })}
            </Typography.Text>
            <div className="mt-3">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.crossing", { defaultValue: "Crossing" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.fringeToMainstream ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
            <div className="mt-5">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.emerging", { defaultValue: "Emerging" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.emergingFringe ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
            <div className="mt-5">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.watch", { defaultValue: "Watchlist" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.narrativeWatch ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
            <div className="mt-5">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.disinfo", { defaultValue: "Disinfo" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.disinfoSignals ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
          </Card>

          <Card
            title={
              <Space size={12}>
                <span>{t("situationMonitor.mainCharacter.title", { defaultValue: "Main Character" })}</span>
                <Tag color="geekblue">
                  {(translateToZh
                    ? data?.mainCharacterSummary?.statusZh ?? data?.mainCharacterSummary?.status
                    : data?.mainCharacterSummary?.status) ?? "NO DATA"}
                </Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)] mt-4"
            loading={loading && !data}
          >
            <Table
              rowKey="name"
              size="small"
              columns={mainCharacterColumns}
              dataSource={data?.mainCharacter?.characters ?? []}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
            />
          </Card>
        </Col>
      </Row>
      */}
    </div>
  );
}
