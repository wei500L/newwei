"use client";

import {
  DownOutlined,
  DragOutlined,
  FileSearchOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Drawer,
  Grid,
  List,
  Popover,
  Progress,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Layout } from "react-grid-layout";
import { useTranslation } from "react-i18next";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { WarMap } from "@/app/(app)/dashboard/charts/war-map";
import { ArticlePublishedTime } from "@/components/article-published-time";
import { usePendingAction } from "@/hooks/use-pending-action";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import {
  SITUATION_MONITOR_PANELS,
  SITUATION_MONITOR_PRESETS,
  type SituationMonitorPanelId,
  useSituationMonitorLayoutStore,
} from "@/store/situation-monitor-layout";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";
import { useUserUiSyncStatusStore } from "@/store/user-ui-sync-status";

import { SituationMonitorLiveNewsPanel } from "./components/situation-monitor-live-news-panel";
import { SituationMonitorLiveWebcamsPanel } from "./components/situation-monitor-live-webcams-panel";
import { useSituationMonitorStream } from "./hooks/use-situation-monitor-stream";
import { SituationMonitorMonitorsPanel } from "./situation-monitor-monitors-panel";
import type { SituationMonitorMatchResult } from "./types/situation-monitor-monitors";
import type {
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationOrefRealtimePayload,
  SituationTelegramFeedResponse,
  SituationTelegramRealtimePayload,
} from "./types/situation-monitor-signals";
import {
  buildPackedResponsiveLayout,
  getDefaultPanelLayoutForBreakpoint,
  GRID_BREAKPOINTS,
  GRID_COLS,
  GRID_LAYOUT_METRICS,
  isPanelSizeCustomizedForBreakpoint,
  stabilizeDesktopDragLayout,
  type GridBreakpoint,
} from "./utils/layout-grid";
import {
  getSituationMonitorMonitorsUpdatedSource,
  SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
} from "./utils/monitor-events";
import {
  buildMonitorMatchKey,
  collectMonitorMatchesForKeys,
  getDefaultMonitorReasonLabel,
} from "./utils/monitor-matches";
import {
  isRecentOrefTimestamp,
  parseOrefTimestamp,
  translateOrefTextForLocale,
} from "./utils/oref-display";
import {
  DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT,
  mergeOrefAlertsRealtime,
  mergeOrefHistoryRealtime,
  mergeTelegramFeedRealtime,
} from "./utils/realtime-signals";
import { buildTelegramFeedQueryParams } from "./utils/telegram-feed";

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

      if (
        typeof responsive !== "function" ||
        typeof widthProvider !== "function"
      ) {
        throw new Error("react-grid-layout exports are not available");
      }

      return (
        widthProvider as (component: GridLayoutComponent) => GridLayoutComponent
      )(responsive as GridLayoutComponent);
    }),
  {
    ssr: false,
  },
);

const TELEGRAM_TOPIC_PRESETS = [
  "breaking",
  "conflict",
  "alerts",
  "osint",
  "politics",
  "middleeast",
  "geopolitics",
  "cyber",
  "other",
] as const;

const SITUATION_MONITOR_INTERACTIVE_SELECTOR = "[data-sm-interactive]";

function stopSituationMonitorInteractiveEvent(event: {
  stopPropagation: () => void;
}) {
  event.stopPropagation();
}

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

type SituationMonitorCategory =
  | "politics"
  | "tech"
  | "finance"
  | "gov"
  | "ai"
  | "intel";

const SITUATION_MONITOR_CATEGORY_KEYS: SituationMonitorCategory[] = [
  "politics",
  "tech",
  "finance",
  "gov",
  "ai",
  "intel",
];

interface SituationMonitorExternalSnapshotCategoryState {
  status: "fresh" | "reused" | "empty";
  articleCount: number;
  contentGeneratedAt: string | null;
  reasonCode?: string;
}

interface SituationMonitorHeadline {
  id: string;
  itemMetaId?: string;
  duplicateOf?: string;
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
  entities?: string[];
  location?: string;
}

interface SituationMonitorEventCluster {
  id: string;
  category: SituationMonitorCategory;
  lead: SituationMonitorHeadline;
  items: SituationMonitorHeadline[];
  internalCount: number;
  externalCount: number;
  distinctSourceCount: number;
  latestTimestamp: number;
  isAlert: boolean;
  mixedSource: boolean;
}

interface SituationMonitorWarning {
  code: string;
  source: "core" | "external" | "gdelt" | "crawl" | "telegram" | "oref";
  severity: "info" | "warning" | "error";
  message: string;
  detail?: string;
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
  headlines: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
  }[];
}

interface SituationMonitorSituationPanel {
  id: "venezuela" | "greenland" | "iran";
  title: string;
  titleZh?: string;
  subtitle: string;
  subtitleZh?: string;
  level: "monitoring" | "elevated" | "critical";
  status: "MONITORING" | "ELEVATED" | "CRITICAL";
  headlines: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
  }[];
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

interface SituationMonitorPizzintSnapshot {
  defcon: number;
  adjustedScore: number;
  openLocations: number;
  activeSpikes: number;
  avgPop: number;
  updatedAt: string;
}

interface SituationMonitorTensionPair {
  id: string;
  label: string;
  score: number;
  changePercent: number;
  trend: "rising" | "stable" | "falling";
  countries: string[];
  updatedAt: string;
}

interface CrossSourceRadarCluster {
  id: string;
  itemCount: number;
  sources: string[];
  samples: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
    itemMetaId?: string;
  }[];
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
  headlines: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
    itemMetaId?: string;
  }[];
  keywords: string[];
  feedback?: { falsePositive: number; falseNegative: number };
  model?: NarrativePropagationModel;
  learning?: {
    boostedTokens: string[];
    blockedTokens: string[];
    suppressedCount: number;
  };
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

interface SituationMonitorCategoryDiagnostics {
  internalCount: number;
  gdeltFallbackCount: number;
  totalCount: number;
  clusterCount: number;
  mixedSourceClusterCount: number;
  distinctSourceCount: number;
}

interface SituationMonitorInsightsDiagnostics {
  requestedScope: "tagged" | "all";
  effectiveScope: "tagged" | "all";
  categories: Record<
    SituationMonitorCategory,
    SituationMonitorCategoryDiagnostics
  >;
}

interface SituationMonitorCoverageSummary {
  mode: "internal+external" | "external-only" | "internal-only" | "empty";
  articleCount: number;
  clusterCount: number;
  internalAnalyzedItems: number;
  externalAnalyzedItems: number;
  mixedSourceClusterCount: number;
  dedupeRatio: number | null;
  avgSourcesPerCluster: number | null;
  visibleCategoryCount: number;
  missingCategories: SituationMonitorCategory[];
  hasOlderItemsOutsideWindow: boolean;
  recommendedWindowHours: number | null;
}

interface SituationMonitorInsightsResponse {
  generatedAt: string;
  windowHours: number;
  maxItems: number;
  analyzedItems: number;
  diagnostics?: SituationMonitorInsightsDiagnostics;
  coverageSummary?: SituationMonitorCoverageSummary;
  warnings?: SituationMonitorWarning[];
  externalSnapshot?: {
    source: "scheduler";
    status: "completed" | "partial" | "failed" | "idle";
    stale: boolean;
    partial: boolean;
    generatedAt: string | null;
    expiresAt: string | null;
    availableCategoryCount: number;
    categories: Record<
      SituationMonitorCategory,
      SituationMonitorExternalSnapshotCategoryState
    >;
    warnings: SituationMonitorWarning[];
  };
  translation?: { target: "zh-CN"; applied: boolean; error?: string };
  headlines?: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  clusters?: Record<SituationMonitorCategory, SituationMonitorEventCluster[]>;
  alerts?: SituationMonitorAlertHeadline[];
  leaders?: SituationMonitorWorldLeader[];
  situations?: SituationMonitorSituationPanel[];
  markets?: SituationMonitorMarketsSnapshot;
  crypto?: SituationMonitorCryptoItem[];
  fed?: SituationMonitorFedSnapshot;
  pizzint?: SituationMonitorPizzintSnapshot;
  tensions?: SituationMonitorTensionPair[];
  correlation?: CorrelationResults | null;
  correlationSummary?: {
    totalSignals: number;
    status: string;
    statusZh?: string;
  };
  narrative?: NarrativeResults | null;
  narrativeSummary?: { total: number; status: string; statusZh?: string };
  mainCharacter?: {
    characters: MainCharacterEntry[];
    topCharacter: MainCharacterEntry | null;
  };
  mainCharacterSummary?: {
    name: string;
    count: number;
    status: string;
    statusZh?: string;
  };
  monitorMatches?: SituationMonitorMatchResult[];
}

interface SituationMonitorCatalogResponse {
  narratives: {
    id: string;
    name: string;
    category: string;
    severity: string;
  }[];
  correlations: { id: string; name: string; category: string }[];
  refreshReadiness: {
    activeSourceCount: number;
    backendRefreshTargets: {
      crawl: boolean;
      telegram: boolean;
      oref: boolean;
      any: boolean;
    };
  };
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

function getHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("response" in error)) {
    return null;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === "number" ? response.status : null;
}

function toAlertType(
  severity: SituationMonitorWarning["severity"],
): "info" | "warning" | "error" {
  if (severity === "error") {
    return "error";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "info";
}

function getExternalSnapshotStatusColor(
  status: NonNullable<
    SituationMonitorInsightsResponse["externalSnapshot"]
  >["status"],
): string {
  if (status === "completed") {
    return "green";
  }
  if (status === "partial") {
    return "gold";
  }
  if (status === "failed") {
    return "red";
  }
  return "default";
}

function getExternalSnapshotCategoryStatusColor(
  status: SituationMonitorExternalSnapshotCategoryState["status"],
): string {
  if (status === "fresh") {
    return "green";
  }
  if (status === "reused") {
    return "gold";
  }
  return "default";
}

function getWindowPresetKey(
  hours: number,
): "6h" | "24h" | "72h" | "168h" | null {
  if (hours === 168) {
    return "168h";
  }
  if (hours === 72) {
    return "72h";
  }
  if (hours === 24) {
    return "24h";
  }
  if (hours === 6) {
    return "6h";
  }
  return null;
}

function getCoverageModeColor(
  mode: NonNullable<
    SituationMonitorInsightsResponse["coverageSummary"]
  >["mode"],
): string {
  if (mode === "internal+external") {
    return "green";
  }
  if (mode === "internal-only") {
    return "blue";
  }
  if (mode === "external-only") {
    return "purple";
  }
  return "default";
}

function extractWarningCategories(
  warning: SituationMonitorWarning | undefined,
): string[] {
  if (!warning?.detail) {
    return [];
  }
  const match = warning.detail.match(/Categories:\s*([^.]+)/i);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
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
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }
  if (Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
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

function filterVisibleLayoutItems(
  layout: Layout[],
  visibility: Record<SituationMonitorPanelId, boolean>,
): Layout[] {
  return layout.filter((item) => visibility[item.i as SituationMonitorPanelId]);
}

function spansOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
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

  if (
    !spansOverlap(
      correlationX,
      correlationX + correlationW,
      monitorsX,
      monitorsX + monitorsW,
    )
  ) {
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

  return layout.map((item) =>
    item.i === "correlation" ? { ...item, h: desiredHeight } : item,
  );
}

function isVisibilityMatchingPreset(
  visibility: Record<SituationMonitorPanelId, boolean>,
  panels: SituationMonitorPanelId[],
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
  const formatWindowOptionLabel = (hours: number): string => {
    const presetKey = getWindowPresetKey(hours);
    if (presetKey) {
      return t(`situationMonitor.window.${presetKey}`, {
        defaultValue:
          presetKey === "168h"
            ? "Last 7d"
            : presetKey === "72h"
              ? "Last 72h"
              : presetKey === "24h"
                ? "Last 24h"
                : "Last 6h",
      });
    }
    return locale === "zh-CN" ? `近${hours}小时` : `${hours}h`;
  };
  const formatWindowCompactLabel = (hours: number): string => {
    const presetKey = getWindowPresetKey(hours);
    if (presetKey) {
      return t(`situationMonitor.windowCompact.${presetKey}`, {
        defaultValue:
          presetKey === "168h"
            ? "7D"
            : presetKey === "72h"
              ? "72H"
              : presetKey === "24h"
                ? "24H"
                : "6H",
      });
    }
    return locale === "zh-CN" ? `${hours}小时` : `${hours}H`;
  };
  const getScopeBadgeLabel = (value: "tagged" | "all"): string =>
    t(`situationMonitor.scopeBadge.${value}`, {
      defaultValue: value === "tagged" ? "TAGGED" : "ALL",
    });
  const getCoverageModeLabel = (
    mode: NonNullable<
      SituationMonitorInsightsResponse["coverageSummary"]
    >["mode"],
  ): string =>
    t(`situationMonitor.coverage.mode.${mode}`, {
      defaultValue:
        mode === "internal+external"
          ? "INT + EXT"
          : mode === "internal-only"
            ? "INT ONLY"
            : mode === "external-only"
              ? "EXT ONLY"
              : "EMPTY",
    });
  const getExternalSnapshotStatusLabel = (
    value: NonNullable<
      SituationMonitorInsightsResponse["externalSnapshot"]
    >["status"],
  ): string =>
    t(`situationMonitor.snapshot.status.${value}`, {
      defaultValue: value.toUpperCase(),
    });
  const getFedMoneyPrinterLabel = (enabled: boolean): string =>
    t(`situationMonitor.fed.moneyPrinter.${enabled ? "on" : "off"}`, {
      defaultValue: enabled ? "PRINTER ON" : "PRINTER OFF",
    });
  const router = useRouter();
  const { data: session, status } = useSession();
  const screens = Grid.useBreakpoint();
  const uiSync = useUserUiSyncStatusStore(
    (state) => state.sections["situation-monitor"],
  );
  const requestUiSyncReload = useUserUiSyncStatusStore(
    (state) => state.requestReload,
  );
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes("items.read") || permissions.includes("items.write");
  const canViewNewsSources =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManageSettings = permissions.includes("settings.manage");
  const hasSignalSession =
    status === "authenticated" && Boolean(session?.accessToken);
  const monitoringSettingsHref = buildAdminSettingsHref({
    page: "monitoring",
    panel: "situation-monitor",
  });

  const windowHours = useSituationMonitorSettingsStore(
    (state) => state.windowHours,
  );
  const setWindowHours = useSituationMonitorSettingsStore(
    (state) => state.setWindowHours,
  );
  const scope = useSituationMonitorSettingsStore((state) => state.scope);
  const setScope = useSituationMonitorSettingsStore((state) => state.setScope);
  const autoRefresh = useSituationMonitorSettingsStore(
    (state) => state.autoRefresh,
  );
  const setAutoRefresh = useSituationMonitorSettingsStore(
    (state) => state.setAutoRefresh,
  );
  const translateToZh = useSituationMonitorSettingsStore(
    (state) => state.translateToZh,
  );
  const setTranslateToZh = useSituationMonitorSettingsStore(
    (state) => state.setTranslateToZh,
  );
  const [refreshStage, setRefreshStage] = useState<
    "idle" | "core" | "external"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [data, setData] = useState<SituationMonitorInsightsResponse | null>(
    null,
  );
  const [telegramFeed, setTelegramFeed] =
    useState<SituationTelegramFeedResponse | null>(null);
  const [orefAlerts, setOrefAlerts] =
    useState<SituationOrefAlertsResponse | null>(null);
  const [orefHistory, setOrefHistory] =
    useState<SituationOrefHistoryResponse | null>(null);
  const [telegramTopicFilter, setTelegramTopicFilter] = useState<string>("all");
  const [telegramChannelFilter, setTelegramChannelFilter] =
    useState<string>("all");
  const [signalsLoading, setSignalsLoading] = useState<{
    telegram: boolean;
    oref: boolean;
  }>({
    telegram: false,
    oref: false,
  });
  const [signalErrors, setSignalErrors] = useState<{
    telegram: string | null;
    oref: string | null;
  }>({
    telegram: null,
    oref: null,
  });
  const [feedbackDrawerOpen, setFeedbackDrawerOpen] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [signalCatalog, setSignalCatalog] =
    useState<SituationMonitorCatalogResponse | null>(null);
  const [missedSignalType, setMissedSignalType] = useState<
    "narrative" | "correlation"
  >("narrative");
  const [missedSignalId, setMissedSignalId] = useState<string>("");
  const [missedHeadlineId, setMissedHeadlineId] = useState<string>("");
  const [expandedClusterIds, setExpandedClusterIds] = useState<string[]>([]);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );
  const refreshIdRef = useRef(0);
  const telegramFeedLoadingRef = useRef(false);
  const pendingTelegramFeedLoadRef = useRef<{ silent: boolean } | null>(null);
  const loadTelegramFeedRef = useRef<
    (options?: { silent?: boolean }) => Promise<void>
  >(async () => undefined);
  const telegramFeedRequestKeyRef = useRef(
    JSON.stringify({
      topic: telegramTopicFilter,
      channel: telegramChannelFilter,
    }),
  );
  const orefSignalsLoadingRef = useRef(false);
  const pendingOrefSignalsLoadRef = useRef<{ silent: boolean } | null>(null);
  const loadOrefSignalsRef = useRef<
    (options?: { silent?: boolean }) => Promise<void>
  >(async () => undefined);
  const loading = refreshStage !== "idle";

  const telegramPanelVisible = useSituationMonitorLayoutStore(
    (state) => state.visibility["telegram-feed"],
  );
  const orefPanelVisible = useSituationMonitorLayoutStore(
    (state) => state.visibility["oref-alerts"],
  );

  const telegramSignalActive = Boolean(
    hasSignalSession && canReadItems && pageVisible && telegramPanelVisible,
  );
  const orefSignalActive = Boolean(
    hasSignalSession && canReadItems && pageVisible && orefPanelVisible,
  );

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  useEffect(() => {
    telegramFeedRequestKeyRef.current = JSON.stringify({
      topic: telegramTopicFilter,
      channel: telegramChannelFilter,
    });
  }, [telegramChannelFilter, telegramTopicFilter]);

  const loadSignalCatalog = useCallback(async () => {
    if (!session?.accessToken || !canReadItems) {
      return null;
    }
    if (signalCatalog) {
      return signalCatalog;
    }
    if (catalogLoading) {
      return null;
    }
    setCatalogLoading(true);
    try {
      const response = await apiClient.get<SituationMonitorCatalogResponse>(
        "situation-monitor/catalog",
      );
      const nextCatalog = response.data ?? null;
      setSignalCatalog(nextCatalog);
      return nextCatalog;
    } catch (err) {
      captureClientError("Failed to load situation monitor catalog", err);
      return null;
    } finally {
      setCatalogLoading(false);
    }
  }, [
    apiClient,
    canReadItems,
    catalogLoading,
    session?.accessToken,
    signalCatalog,
  ]);

  useEffect(() => {
    void loadSignalCatalog();
  }, [loadSignalCatalog]);

  const loadTelegramFeed = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!session?.accessToken || !canReadItems) {
        return;
      }

      const silent = options?.silent ?? false;
      if (telegramFeedLoadingRef.current) {
        const pending = pendingTelegramFeedLoadRef.current;
        pendingTelegramFeedLoadRef.current = {
          silent: pending ? pending.silent && silent : silent,
        };
        return;
      }

      telegramFeedLoadingRef.current = true;
      const requestKey = JSON.stringify({
        topic: telegramTopicFilter,
        channel: telegramChannelFilter,
      });
      if (!silent) {
        setSignalsLoading((prev) => ({ ...prev, telegram: true }));
      }
      setSignalErrors((prev) => ({ ...prev, telegram: null }));

      try {
        const response = await apiClient.get<SituationTelegramFeedResponse>(
          "situation-monitor/telegram-feed",
          {
            params: buildTelegramFeedQueryParams(
              {
                topic: telegramTopicFilter,
                channel: telegramChannelFilter,
              },
              { limit: DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT },
            ),
          },
        );
        if (telegramFeedRequestKeyRef.current != requestKey) {
          return;
        }
        setTelegramFeed(response.data ?? null);
        setSignalErrors((prev) => ({ ...prev, telegram: null }));
      } catch (err) {
        captureClientError(
          "Failed to load situation monitor telegram feed",
          err,
        );
        const statusCode = getHttpStatus(err);
        if (statusCode === 401 || statusCode === 403) {
          setTelegramFeed(null);
        }
        setSignalErrors((prev) => ({
          ...prev,
          telegram:
            extractApiError(err).message || "Failed to load Telegram signals.",
        }));
      } finally {
        telegramFeedLoadingRef.current = false;
        if (!silent) {
          setSignalsLoading((prev) => ({ ...prev, telegram: false }));
        }
        const pending = pendingTelegramFeedLoadRef.current;
        pendingTelegramFeedLoadRef.current = null;
        if (pending) {
          void loadTelegramFeedRef.current(pending);
        }
      }
    },
    [
      apiClient,
      canReadItems,
      session?.accessToken,
      telegramChannelFilter,
      telegramTopicFilter,
    ],
  );

  const loadOrefSignals = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!session?.accessToken || !canReadItems) {
        return;
      }

      const silent = options?.silent ?? false;
      if (orefSignalsLoadingRef.current) {
        const pending = pendingOrefSignalsLoadRef.current;
        pendingOrefSignalsLoadRef.current = {
          silent: pending ? pending.silent && silent : silent,
        };
        return;
      }

      orefSignalsLoadingRef.current = true;
      if (!silent) {
        setSignalsLoading((prev) => ({ ...prev, oref: true }));
      }
      setSignalErrors((prev) => ({ ...prev, oref: null }));

      try {
        const [alertsResponse, historyResponse] = await Promise.all([
          apiClient.get<SituationOrefAlertsResponse>(
            "situation-monitor/oref-alerts",
          ),
          apiClient.get<SituationOrefHistoryResponse>(
            "situation-monitor/oref-history",
          ),
        ]);

        setOrefAlerts(alertsResponse.data ?? null);
        setOrefHistory(historyResponse.data ?? null);
        setSignalErrors((prev) => ({ ...prev, oref: null }));
      } catch (err) {
        captureClientError(
          "Failed to load situation monitor OREF signals",
          err,
        );
        const statusCode = getHttpStatus(err);
        if (statusCode === 401 || statusCode === 403) {
          setOrefAlerts(null);
          setOrefHistory(null);
        }
        setSignalErrors((prev) => ({
          ...prev,
          oref: extractApiError(err).message || "Failed to load OREF signals.",
        }));
      } finally {
        orefSignalsLoadingRef.current = false;
        if (!silent) {
          setSignalsLoading((prev) => ({ ...prev, oref: false }));
        }
        const pending = pendingOrefSignalsLoadRef.current;
        pendingOrefSignalsLoadRef.current = null;
        if (pending) {
          void loadOrefSignalsRef.current(pending);
        }
      }
    },
    [apiClient, canReadItems, session?.accessToken],
  );

  useEffect(() => {
    loadTelegramFeedRef.current = loadTelegramFeed;
  }, [loadTelegramFeed]);

  useEffect(() => {
    loadOrefSignalsRef.current = loadOrefSignals;
  }, [loadOrefSignals]);

  const load = useCallback(
    async (options?: {
      includeExternal?: boolean;
      scopeOverride?: "tagged" | "all";
    }) => {
      if (!session?.accessToken) {
        return;
      }
      const includeExternal = options?.includeExternal ?? true;
      const requestedScope = options?.scopeOverride ?? scope;
      const refreshId = (refreshIdRef.current += 1);
      setRefreshStage("core");
      setError(null);
      try {
        const coreResponse =
          await apiClient.get<SituationMonitorInsightsResponse>(
            "situation-monitor/insights",
            {
              params: {
                windowHours,
                maxItems: 400,
                sections: "core",
                scope: requestedScope,
                translate: translateToZh ? "zh-CN" : undefined,
              },
            },
          );

        if (refreshIdRef.current !== refreshId) {
          return;
        }

        const coreData = coreResponse.data ?? null;
        if (coreData) {
          setData((prev) => {
            if (!prev) {
              return {
                ...coreData,
                warnings: coreData.warnings ?? [],
              };
            }
            return {
              ...prev,
              ...coreData,
              warnings: coreData.warnings ?? [],
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

        const externalResponse =
          await apiClient.get<SituationMonitorInsightsResponse>(
            "situation-monitor/insights",
            {
              params: {
                windowHours,
                maxItems: 400,
                sections: "external",
                scope: requestedScope,
                translate: translateToZh ? "zh-CN" : undefined,
              },
            },
          );

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
            merged.monitorMatches = prev.monitorMatches;

            // Still surface the latest refresh timestamp so the header reflects the most recent load.
            if (externalData.generatedAt) {
              merged.generatedAt = externalData.generatedAt;
            }

            merged.translation = mergeTranslationStatus(
              prev.translation,
              externalData.translation,
            );
            return merged;
          });
        }
      } catch (err) {
        captureClientError("Failed to load situation monitor insights", err);
        if (refreshIdRef.current === refreshId) {
          setError(
            extractApiError(err).message ||
              "Failed to load situation monitor insights.",
          );
        }
      } finally {
        if (refreshIdRef.current === refreshId) {
          setRefreshStage("idle");
        }
      }
    },
    [apiClient, scope, session?.accessToken, translateToZh, windowHours],
  );

  const { pending: manualRefreshPending, run: runManualRefresh } =
    usePendingAction(async () => {
      if (!session?.accessToken) {
        return;
      }

      await Promise.allSettled([
        load(),
        telegramSignalActive
          ? loadTelegramFeedRef.current()
          : Promise.resolve(undefined),
        orefSignalActive
          ? loadOrefSignalsRef.current()
          : Promise.resolve(undefined),
      ]);
    });

  const effectiveScope = data?.diagnostics?.effectiveScope ?? scope;
  const taggedScopeNoResults =
    !loading &&
    !error &&
    effectiveScope === "tagged" &&
    (data?.analyzedItems ?? 0) === 0;
  const allScopeNoResults =
    !loading &&
    !error &&
    effectiveScope === "all" &&
    (data?.analyzedItems ?? 0) === 0;
  const insightsWarnings = data?.warnings ?? [];
  const coverageSummary = data?.coverageSummary;
  const recommendedWindowHours =
    coverageSummary?.recommendedWindowHours ?? null;
  const noActiveSourcesConfigured =
    (signalCatalog?.refreshReadiness.activeSourceCount ?? 0) === 0;
  const rateLimitedCategories = useMemo(
    () =>
      new Set(
        (data?.externalSnapshot?.warnings ?? [])
          .filter((warning) => warning.code === "gdelt_rate_limited")
          .flatMap((warning) => extractWarningCategories(warning)),
      ),
    [data?.externalSnapshot?.warnings],
  );
  const freshSnapshotCategoryCount = useMemo(
    () =>
      SITUATION_MONITOR_CATEGORY_KEYS.filter(
        (category) =>
          data?.externalSnapshot?.categories?.[category]?.status === "fresh",
      ).length,
    [data?.externalSnapshot?.categories],
  );
  const reusedSnapshotCategoryCount = useMemo(
    () =>
      SITUATION_MONITOR_CATEGORY_KEYS.filter(
        (category) =>
          data?.externalSnapshot?.categories?.[category]?.status === "reused",
      ).length,
    [data?.externalSnapshot?.categories],
  );
  const allScopeEmptyState = useMemo(() => {
    if (!allScopeNoResults) {
      return null;
    }

    if (noActiveSourcesConfigured) {
      return {
        type: "info" as const,
        message: t("situationMonitor.empty.unconfigured.title", {
          defaultValue: "Internal monitoring is not configured yet.",
        }),
        description: t("situationMonitor.empty.unconfigured.description", {
          defaultValue:
            "This workspace has no active internal news sources. You are currently limited to shared external snapshot coverage.",
        }),
      };
    }

    if (coverageSummary?.hasOlderItemsOutsideWindow && recommendedWindowHours) {
      return {
        type: "info" as const,
        message: t("situationMonitor.empty.window.title", {
          defaultValue: "Current window is too narrow.",
        }),
        description: t("situationMonitor.empty.window.description", {
          defaultValue:
            "No items are visible in the current window, but older coverage is available in the last 7 days.",
        }),
      };
    }

    if (data?.externalSnapshot?.status === "partial") {
      return {
        type: "warning" as const,
        message: t("situationMonitor.empty.partial.title", {
          defaultValue: "External snapshot coverage is partial right now.",
        }),
        description: t("situationMonitor.empty.partial.description", {
          defaultValue:
            "Some categories are unavailable because the latest external snapshot was only partially generated.",
        }),
      };
    }

    return {
      type: "warning" as const,
      message: t("situationMonitor.empty.generic.title", {
        defaultValue: "No content is available right now.",
      }),
      description: t("situationMonitor.empty.generic.description", {
        defaultValue:
          "There are no internal items or external snapshot headlines available for the current view.",
      }),
    };
  }, [
    allScopeNoResults,
    coverageSummary?.hasOlderItemsOutsideWindow,
    data?.externalSnapshot?.status,
    noActiveSourcesConfigured,
    recommendedWindowHours,
    t,
  ]);
  const refreshActionItems = useMemo(() => {
    const actions: {
      key: string;
      label: string;
      onClick: () => void;
    }[] = [];

    if (noActiveSourcesConfigured && canViewNewsSources) {
      actions.push({
        key: "news-sources",
        label: t("situationMonitor.actions.openNewsSources", {
          defaultValue: "Open News Sources",
        }),
        onClick: () => router.push("/admin/ops/news-sources"),
      });
    }

    if (
      ((data?.externalSnapshot?.warnings.length ?? 0) > 0 ||
        signalErrors.telegram ||
        signalErrors.oref) &&
      canManageSettings
    ) {
      actions.push({
        key: "monitoring-settings",
        label: t("situationMonitor.actions.openSettings", {
          defaultValue: "Open Situation Monitor Settings",
        }),
        onClick: () => router.push(monitoringSettingsHref),
      });
    }

    return actions;
  }, [
    canManageSettings,
    canViewNewsSources,
    data?.externalSnapshot?.warnings.length,
    monitoringSettingsHref,
    noActiveSourcesConfigured,
    router,
    signalErrors.oref,
    signalErrors.telegram,
    t,
  ]);

  const handleManualRefresh = useCallback(() => {
    void runManualRefresh();
  }, [runManualRefresh]);
  const toggleClusterExpansion = useCallback((clusterId: string) => {
    setExpandedClusterIds((previous) =>
      previous.includes(clusterId)
        ? previous.filter((value) => value !== clusterId)
        : [...previous, clusterId],
    );
  }, []);
  const summaryActionItems = useMemo(() => {
    const actions: {
      key: string;
      label: string;
      onClick: () => void;
      type?: "primary" | "default";
    }[] = [
      {
        key: "refresh-page-data",
        label: t("situationMonitor.actions.refreshPageData", {
          defaultValue: "Refresh page data",
        }),
        onClick: handleManualRefresh,
        type: "primary",
      },
    ];

    if (recommendedWindowHours) {
      actions.push({
        key: "recommended-window",
        label: t("situationMonitor.actions.switchWindow", {
          defaultValue: "Switch to {{window}}",
          window: formatWindowOptionLabel(recommendedWindowHours),
        }),
        onClick: () => {
          setWindowHours(recommendedWindowHours);
        },
      });
    }

    for (const action of refreshActionItems) {
      actions.push({
        key: action.key,
        label: action.label,
        onClick: action.onClick,
      });
    }

    return actions;
  }, [
    handleManualRefresh,
    recommendedWindowHours,
    refreshActionItems,
    setWindowHours,
    t,
  ]);

  const submitSignalFeedback = useCallback(
    async (payload: {
      signalType: "narrative" | "correlation";
      signalId: string;
      label: "false_positive" | "false_negative";
      item?: {
        itemMetaId?: string;
        title?: string;
        source?: string;
        link?: string;
      } | null;
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
              ? t("common.feedbackSaved", {
                  defaultValue: "Marked as false positive.",
                })
              : t("common.feedbackSaved", {
                  defaultValue: "Marked as missed detection.",
                }),
        });
        void load({ includeExternal: false });
        setTimeout(() => setFeedbackNotice(null), 3500);
      } catch (err) {
        captureClientError("Failed to submit situation monitor feedback", err);
        setFeedbackNotice({
          type: "error",
          message: t("common.feedbackFailed", {
            defaultValue: "Failed to submit feedback.",
          }),
        });
        setTimeout(() => setFeedbackNotice(null), 4000);
      }
    },
    [apiClient, load, session?.accessToken, t],
  );

  const handleRealtimeTelegramUpdate = useCallback(
    (payload: SituationTelegramRealtimePayload) => {
      if (!telegramSignalActive) {
        return;
      }
      setSignalErrors((prev) =>
        prev.telegram ? { ...prev, telegram: null } : prev,
      );
      setTelegramFeed((prev) =>
        mergeTelegramFeedRealtime(
          prev,
          payload,
          {
            topic: telegramTopicFilter,
            channel: telegramChannelFilter,
          },
          { limit: DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT },
        ),
      );
    },
    [telegramChannelFilter, telegramSignalActive, telegramTopicFilter],
  );

  const handleRealtimeOrefUpdate = useCallback(
    (payload: SituationOrefRealtimePayload) => {
      if (!orefSignalActive) {
        return;
      }
      setSignalErrors((prev) => (prev.oref ? { ...prev, oref: null } : prev));
      setOrefAlerts((prev) => mergeOrefAlertsRealtime(prev, payload));
      setOrefHistory((prev) => mergeOrefHistoryRealtime(prev, payload));
    },
    [orefSignalActive],
  );

  const realtimeState = useSituationMonitorStream({
    enabled: telegramSignalActive || orefSignalActive,
    onTelegramUpdate: handleRealtimeTelegramUpdate,
    onOrefUpdate: handleRealtimeOrefUpdate,
  });

  const telegramPollingActive =
    telegramSignalActive && !realtimeState.connected;
  const orefPollingActive = orefSignalActive && !realtimeState.connected;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const onVisibilityChange = () => {
      setPageVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!telegramSignalActive) {
      return;
    }
    void loadTelegramFeed();
  }, [loadTelegramFeed, telegramSignalActive]);

  useEffect(() => {
    if (!orefSignalActive) {
      return;
    }
    void loadOrefSignals();
  }, [loadOrefSignals, orefSignalActive]);

  useEffect(() => {
    if (!autoRefresh || !pageVisible) {
      return;
    }
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, load, pageVisible]);

  useEffect(() => {
    if (!telegramPollingActive) {
      return;
    }
    const timer = setInterval(() => {
      void loadTelegramFeed({ silent: true });
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadTelegramFeed, telegramPollingActive]);

  useEffect(() => {
    if (!orefPollingActive) {
      return;
    }
    const timer = setInterval(() => {
      void loadOrefSignals({ silent: true });
    }, 120_000);
    return () => clearInterval(timer);
  }, [loadOrefSignals, orefPollingActive]);

  useEffect(() => {
    return () => {
      pendingTelegramFeedLoadRef.current = null;
      pendingOrefSignalsLoadRef.current = null;
    };
  }, []);

  const feedbackCandidateHeadlines = useMemo(() => {
    const headlinesByCategory = data?.headlines;
    if (!headlinesByCategory) {
      return [] as SituationMonitorHeadline[];
    }

    const entries = Object.values(headlinesByCategory).flatMap((list) =>
      Array.isArray(list) ? list : [],
    );
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
    return new Map<string, SituationMonitorHeadline>(
      feedbackCandidateHeadlines.map((headline) => [headline.id, headline]),
    );
  }, [feedbackCandidateHeadlines]);

  const allMonitorMatches = useMemo(() => {
    return [
      ...(data?.monitorMatches ?? []),
      ...(telegramFeed?.monitorMatches ?? []),
      ...(orefAlerts?.monitorMatches ?? []),
      ...(orefHistory?.monitorMatches ?? []),
    ];
  }, [
    data?.monitorMatches,
    orefAlerts?.monitorMatches,
    orefHistory?.monitorMatches,
    telegramFeed?.monitorMatches,
  ]);

  const monitorColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const match of allMonitorMatches) {
      if (match.monitorColor) {
        map.set(match.monitorId, match.monitorColor);
      }
    }
    return map;
  }, [allMonitorMatches]);

  const monitorMatchesByKey = useMemo(() => {
    const map = new Map<string, SituationMonitorMatchResult[]>();
    for (const match of allMonitorMatches) {
      const existing = map.get(match.itemKey);
      if (existing) {
        existing.push(match);
      } else {
        map.set(match.itemKey, [match]);
      }
    }

    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          b.score - a.score || a.monitorName.localeCompare(b.monitorName),
      );
    }

    return map;
  }, [allMonitorMatches]);

  const emergingColumns: ColumnsType<EmergingPattern> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>
            {translateToZh ? (record.nameZh ?? record.name) : record.name}
          </span>
          <Tag color={toTagColor(record.level)}>
            {t(
              `situationMonitor.correlation.level.${record.level.toLowerCase()}`,
              {
                defaultValue: record.level.toUpperCase(),
              },
            )}
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
      title: t("situationMonitor.correlation.sources", {
        defaultValue: "Sources",
      }),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) =>
        Array.isArray(value) ? value.slice(0, 4).join(", ") : "",
    },
    {
      title: t("situationMonitor.correlation.sample", {
        defaultValue: "Sample",
      }),
      dataIndex: "headlines",
      key: "headlines",
      render: (value: HeadlineRef[]) => {
        const first = Array.isArray(value) ? value[0] : undefined;
        const href = first?.link ? safeHttpUrl(first.link) : null;
        if (!first) return null;
        const title = translateToZh
          ? (first.titleZh ?? first.title)
          : first.title;
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
      title: t("situationMonitor.correlation.feedback", {
        defaultValue: "Feedback",
      }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                      {t("situationMonitor.narrative.boosted", {
                        defaultValue: "Boosted",
                      })}
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
                      {t("situationMonitor.narrative.blocked", {
                        defaultValue: "Blocked",
                      })}
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
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
                      }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", {
                defaultValue: "False +",
              })}
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
      render: (_value: string, record) =>
        translateToZh ? (record.nameZh ?? record.name) : record.name,
    },
    {
      title: t("situationMonitor.correlation.current", {
        defaultValue: "Current",
      }),
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
        <Typography.Text type={value >= 0 ? "success" : "danger"}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t("situationMonitor.correlation.momentum", {
        defaultValue: "Momentum",
      }),
      dataIndex: "momentum",
      key: "momentum",
      width: 110,
      render: (value: MomentumSignal["momentum"]) => {
        const normalized = value.toLowerCase();
        const color =
          normalized === "surging"
            ? "red"
            : normalized === "rising"
              ? "orange"
              : "default";
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
      title: t("situationMonitor.correlation.feedback", {
        defaultValue: "Feedback",
      }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                      {t("situationMonitor.narrative.boosted", {
                        defaultValue: "Boosted",
                      })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-m-${record.id}-${token}`}>
                          {token}
                        </Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", {
                        defaultValue: "Blocked",
                      })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-m-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
                      }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", {
                defaultValue: "False +",
              })}
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
      render: (_value: string, record) =>
        translateToZh ? (record.nameZh ?? record.name) : record.name,
    },
    {
      title: t("situationMonitor.correlation.score", { defaultValue: "Score" }),
      dataIndex: "score",
      key: "score",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.confidence", {
        defaultValue: "Confidence",
      }),
      dataIndex: "confidence",
      key: "confidence",
      width: 120,
      render: (value: number) => `${value}%`,
    },
    {
      title: t("situationMonitor.correlation.prediction", {
        defaultValue: "Prediction",
      }),
      dataIndex: "prediction",
      key: "prediction",
      render: (_value: string, record) =>
        translateToZh
          ? (record.predictionZh ?? record.prediction)
          : record.prediction,
    },
    {
      title: t("situationMonitor.correlation.feedback", {
        defaultValue: "Feedback",
      }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                      {t("situationMonitor.narrative.boosted", {
                        defaultValue: "Boosted",
                      })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-p-${record.id}-${token}`}>
                          {token}
                        </Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", {
                        defaultValue: "Blocked",
                      })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-p-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
                      }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", {
                defaultValue: "False +",
              })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const realtimeSnapshotTensionLimit = screens.lg ? 4 : screens.md ? 3 : 2;
  const showRealtimeSnapshotChangeColumn = Boolean(screens.md);

  const tensionColumns: ColumnsType<SituationMonitorTensionPair> = [
    {
      title: t("situationMonitor.realtimeSnapshot.tensionPair", {
        defaultValue: "Pair",
      }),
      dataIndex: "label",
      key: "label",
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text ellipsis={{ tooltip: value }}>
          {value || "—"}
        </Typography.Text>
      ),
    },
    {
      title: t("situationMonitor.realtimeSnapshot.score", {
        defaultValue: "Score",
      }),
      dataIndex: "score",
      key: "score",
      width: 90,
      render: (value: number) =>
        Number.isFinite(value) ? value.toFixed(1) : "—",
    },
    ...(showRealtimeSnapshotChangeColumn
      ? [
          {
            title: t("situationMonitor.realtimeSnapshot.changePct", {
              defaultValue: "Change",
            }),
            dataIndex: "changePercent",
            key: "changePercent",
            width: 100,
            render: (value: number) => (
              <Typography.Text
                type={
                  value > 0 ? "danger" : value < 0 ? "success" : "secondary"
                }
              >
                {formatPercent(value)}
              </Typography.Text>
            ),
          },
        ]
      : []),
    {
      title: t("situationMonitor.realtimeSnapshot.trend", {
        defaultValue: "Trend",
      }),
      dataIndex: "trend",
      key: "trend",
      width: 100,
      render: (value: SituationMonitorTensionPair["trend"]) => {
        const normalized = value.toLowerCase();
        const color =
          normalized === "rising"
            ? "red"
            : normalized === "falling"
              ? "green"
              : "default";
        return (
          <Tag color={color}>
            {t(`situationMonitor.realtimeSnapshot.trendStatus.${normalized}`, {
              defaultValue: normalized.toUpperCase(),
            })}
          </Tag>
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
          <span>
            {translateToZh ? (record.nameZh ?? record.name) : record.name}
          </span>
          <Tag color={toTagColor(record.level)}>
            {t(
              `situationMonitor.correlation.level.${record.level.toLowerCase()}`,
              {
                defaultValue: record.level.toUpperCase(),
              },
            )}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.sources", {
        defaultValue: "Sources",
      }),
      dataIndex: "sourceCount",
      key: "sourceCount",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sourcesList", {
        defaultValue: "Source list",
      }),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) =>
        Array.isArray(value) ? value.slice(0, 4).join(", ") : "",
    },
    {
      title: t("situationMonitor.correlation.sample", {
        defaultValue: "Sample",
      }),
      dataIndex: "headlines",
      key: "headlines",
      render: (value: HeadlineRef[]) => {
        const first = Array.isArray(value) ? value[0] : undefined;
        const href = first?.link ? safeHttpUrl(first.link) : null;
        if (!first) return null;
        const title = translateToZh
          ? (first.titleZh ?? first.title)
          : first.title;
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
      title: t("situationMonitor.correlation.feedback", {
        defaultValue: "Feedback",
      }),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                      {t("situationMonitor.narrative.boosted", {
                        defaultValue: "Boosted",
                      })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`c-boost-x-${record.id}-${token}`}>
                          {token}
                        </Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked", {
                        defaultValue: "Blocked",
                      })}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`c-block-x-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
                      }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", {
                defaultValue: "False +",
              })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  type CorrelationRow =
    | EmergingPattern
    | MomentumSignal
    | CrossSourceCorrelation
    | PredictiveSignal;

  const correlationExpandable = useMemo(() => {
    const expandRowLabel = t("common.expand", {
      defaultValue: "Expand",
    });
    const collapseRowLabel = t("common.collapse", {
      defaultValue: "Collapse",
    });

    return {
      rowExpandable: (record: CorrelationRow) => {
        const boosted = record.learning?.boostedTokens?.length ?? 0;
        const blocked = record.learning?.blockedTokens?.length ?? 0;
        const suppressed = record.learning?.suppressedCount ?? 0;
        const fp = record.feedback?.falsePositive ?? 0;
        const fn = record.feedback?.falseNegative ?? 0;
        return boosted > 0 || blocked > 0 || suppressed > 0 || fp > 0 || fn > 0;
      },
      expandIcon: ({
        expanded,
        onExpand,
        record,
      }: {
        expanded: boolean;
        onExpand: (
          record: CorrelationRow,
          event: ReactMouseEvent<HTMLElement>,
        ) => void;
        record: CorrelationRow;
      }) => {
        if (!record) {
          return null;
        }

        const canExpand =
          (record.learning?.boostedTokens?.length ?? 0) > 0 ||
          (record.learning?.blockedTokens?.length ?? 0) > 0 ||
          (record.learning?.suppressedCount ?? 0) > 0 ||
          (record.feedback?.falsePositive ?? 0) > 0 ||
          (record.feedback?.falseNegative ?? 0) > 0;

        if (!canExpand) {
          return <span aria-hidden className="inline-block w-7" />;
        }

        return (
          <Button
            data-sm-interactive
            type="text"
            size="small"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            aria-label={`${expanded ? collapseRowLabel : expandRowLabel} row`}
            onPointerDown={stopSituationMonitorInteractiveEvent}
            onMouseDown={stopSituationMonitorInteractiveEvent}
            onClick={(event) => {
              stopSituationMonitorInteractiveEvent(event);
              onExpand(record, event);
            }}
          />
        );
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
                defaultValue:
                  "Feedback-driven learning: boosted/blocked tokens and per-item suppression.",
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
                  {t("situationMonitor.narrative.boosted", {
                    defaultValue: "Boosted",
                  })}
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
                  {t("situationMonitor.narrative.blocked", {
                    defaultValue: "Blocked",
                  })}
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
      title: t("situationMonitor.narrative.name", {
        defaultValue: "Narrative",
      }),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>
            {translateToZh ? (record.nameZh ?? record.name) : record.name}
          </span>
          <Tag color={record.severity === "disinfo" ? "red" : "default"}>
            {t(`situationMonitor.narrative.${record.severity.toLowerCase()}`, {
              defaultValue: record.severity.toUpperCase(),
            })}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.narrative.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 90,
    },
    {
      title: t("situationMonitor.narrative.fringe", { defaultValue: "Fringe" }),
      dataIndex: "fringeCount",
      key: "fringeCount",
      width: 90,
    },
    {
      title: t("situationMonitor.narrative.alternative", {
        defaultValue: "Alt",
      }),
      dataIndex: "alternativeCount",
      key: "alternativeCount",
      width: 80,
    },
    {
      title: t("situationMonitor.narrative.mainstream", {
        defaultValue: "Mainstream",
      }),
      dataIndex: "mainstreamCount",
      key: "mainstreamCount",
      width: 110,
    },
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
                  {t("situationMonitor.narrative.consistency", {
                    defaultValue: "Consistency",
                  })}
                  : {consistency}%
                </Typography.Text>
                <Typography.Text>
                  {t("situationMonitor.narrative.divergence", {
                    defaultValue: "Divergence",
                  })}
                  : {divergence}%
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.clusters", {
                    defaultValue: "Clusters",
                  })}
                  : {radar.clusterCount ?? 0}
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
      title: t("situationMonitor.narrative.credibility", {
        defaultValue: "Credibility",
      }),
      key: "credibility",
      width: 130,
      render: (_, record) => {
        const credibility = record.model?.credibility;
        if (!credibility) return "—";
        const reasons = Array.isArray(credibility.reasons)
          ? credibility.reasons
          : [];
        const components = credibility.components;
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                {reasons.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>
                      {t("situationMonitor.narrative.credibilityReasons", {
                        defaultValue: "Reasons",
                      })}
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
                    {t("situationMonitor.narrative.credibilityBreakdown", {
                      defaultValue: "Breakdown",
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.sourceReliability", {
                      defaultValue: "Source reliability",
                    })}
                  </Typography.Text>
                  <Progress
                    percent={Math.round(
                      (components.sourceReliability ?? 0) * 100,
                    )}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.corroboration", {
                      defaultValue: "Corroboration",
                    })}
                  </Typography.Text>
                  <Progress
                    percent={Math.round((components.corroboration ?? 0) * 100)}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.citationSupport", {
                      defaultValue: "Citation support",
                    })}
                  </Typography.Text>
                  <Progress
                    percent={Math.round(
                      (components.citationSupport ?? 0) * 100,
                    )}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.divergence", {
                      defaultValue: "Divergence",
                    })}
                  </Typography.Text>
                  <Progress
                    percent={Math.round((components.divergence ?? 0) * 100)}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.feedbackPenalty", {
                      defaultValue: "Feedback penalty",
                    })}
                  </Typography.Text>
                  <Progress
                    percent={Math.round(
                      (components.feedbackPenalty ?? 0) * 100,
                    )}
                    size="small"
                    showInfo={false}
                  />
                </Space>
              </Space>
            }
          >
            <Tag color={toCredibilityColor(credibility.level)}>
              {t(
                `situationMonitor.narrative.credibilityLevel.${credibility.level.toLowerCase()}`,
                {
                  defaultValue: credibility.level.toUpperCase(),
                },
              )}{" "}
              {credibility.score}
            </Tag>
          </Popover>
        );
      },
    },
    {
      title: t("situationMonitor.narrative.feedback", {
        defaultValue: "Feedback",
      }),
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
                      {t("situationMonitor.narrative.boosted", {
                        defaultValue: "Boosted",
                      })}
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
                      {t("situationMonitor.narrative.blocked", {
                        defaultValue: "Blocked",
                      })}
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
                    ? {
                        itemMetaId: headline.itemMetaId,
                        title: headline.title,
                        source: headline.source,
                        link: headline.link,
                      }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive", {
                defaultValue: "False +",
              })}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const narrativeExpandable = useMemo(() => {
    const expandRowLabel = t("common.expand", {
      defaultValue: "Expand",
    });
    const collapseRowLabel = t("common.collapse", {
      defaultValue: "Collapse",
    });

    return {
      rowExpandable: (record: NarrativeData) => Boolean(record.model),
      expandIcon: ({
        expanded,
        onExpand,
        record,
      }: {
        expanded: boolean;
        onExpand: (
          record: NarrativeData,
          event: ReactMouseEvent<HTMLElement>,
        ) => void;
        record: NarrativeData;
      }) => {
        if (!record?.model) {
          return <span aria-hidden className="inline-block w-7" />;
        }

        return (
          <Button
            data-sm-interactive
            type="text"
            size="small"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            aria-label={`${expanded ? collapseRowLabel : expandRowLabel} row`}
            onPointerDown={stopSituationMonitorInteractiveEvent}
            onMouseDown={stopSituationMonitorInteractiveEvent}
            onClick={(event) => {
              stopSituationMonitorInteractiveEvent(event);
              onExpand(record, event);
            }}
          />
        );
      },
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
        const lagLabel = path.lagToMainstreamMs
          ? formatDurationMs(path.lagToMainstreamMs)
          : "—";

        return (
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.path", {
                  defaultValue: "Fringe → Mainstream Path",
                })}
              </Typography.Text>
              <div className="mt-1">
                <Typography.Text>{stepsLabel || "—"}</Typography.Text>
              </div>
              <div className="mt-1">
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.lag", {
                    defaultValue: "Lag to mainstream",
                  })}
                  : {lagLabel}
                </Typography.Text>
              </div>
              <div className="mt-2">
                <Space direction="vertical" size={2}>
                  {path.steps.map((step) => {
                    const firstSeen = step.firstSeenAt
                      ? new Date(step.firstSeenAt)
                      : null;
                    const lastSeen = step.lastSeenAt
                      ? new Date(step.lastSeenAt)
                      : null;
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
                {t("situationMonitor.narrative.radarDetail", {
                  defaultValue: "Cross-source Radar",
                })}
              </Typography.Text>
              <div className="mt-2">
                <Space size={10} wrap>
                  <Tag color="geekblue">
                    {t("situationMonitor.narrative.consistency", {
                      defaultValue: "Consistency",
                    })}
                    : {Math.round((radar.consistency ?? 0) * 100)}%
                  </Tag>
                  <Tag color="gold">
                    {t("situationMonitor.narrative.divergence", {
                      defaultValue: "Divergence",
                    })}
                    : {Math.round((radar.divergence ?? 0) * 100)}%
                  </Tag>
                  <Tag>
                    {t("situationMonitor.narrative.clusters", {
                      defaultValue: "Clusters",
                    })}
                    : {radar.clusterCount ?? 0}
                  </Tag>
                  <Tag color={toCredibilityColor(credibility.level)}>
                    {t("situationMonitor.narrative.credibility", {
                      defaultValue: "Credibility",
                    })}
                    : {credibility.score}
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
                    {t("situationMonitor.narrative.outliers", {
                      defaultValue: "Outliers",
                    })}
                    :
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
                  <Space
                    direction="vertical"
                    size={4}
                    style={{ width: "100%" }}
                  >
                    {radar.clusters.slice(0, 4).map((cluster) => (
                      <div key={cluster.id}>
                        <Typography.Text type="secondary">
                          {cluster.id}: {cluster.itemCount}{" "}
                          {cluster.sources?.length
                            ? `· ${cluster.sources.slice(0, 4).join(", ")}`
                            : ""}
                        </Typography.Text>
                      </div>
                    ))}
                  </Space>
                </div>
              ) : null}
            </Col>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.citations", {
                  defaultValue: "Citation Chain",
                })}
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
                    {t("situationMonitor.narrative.citationLinks", {
                      defaultValue: "Top links",
                    })}
                  </Typography.Text>
                  <div className="mt-1">
                    <Space direction="vertical" size={2}>
                      {citation.links.slice(0, 6).map((link) => (
                        <Typography.Text
                          key={`${link.from}=>${link.to}`}
                          type="secondary"
                        >
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
                    {t("situationMonitor.narrative.learning", {
                      defaultValue: "Learning",
                    })}
                  </Typography.Text>
                  <div className="mt-2">
                    <Space size={8} wrap>
                      <Tag color="red">
                        FP {record.feedback?.falsePositive ?? 0}
                      </Tag>
                      <Tag color="gold">
                        FN {record.feedback?.falseNegative ?? 0}
                      </Tag>
                      <Tag>SUP {record.learning?.suppressedCount ?? 0}</Tag>
                    </Space>
                    {record.learning?.boostedTokens?.length ? (
                      <Space size={6} wrap>
                        <Typography.Text type="secondary">
                          {t("situationMonitor.narrative.boosted", {
                            defaultValue: "Boosted",
                          })}
                          :
                        </Typography.Text>
                        {record.learning.boostedTokens
                          .slice(0, 8)
                          .map((token) => (
                            <Tag key={`boost-${token}`}>{token}</Tag>
                          ))}
                      </Space>
                    ) : null}
                    {record.learning?.blockedTokens?.length ? (
                      <div className="mt-1">
                        <Space size={6} wrap>
                          <Typography.Text type="secondary">
                            {t("situationMonitor.narrative.blocked", {
                              defaultValue: "Blocked",
                            })}
                            :
                          </Typography.Text>
                          {record.learning.blockedTokens
                            .slice(0, 8)
                            .map((token) => (
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
    {
      title: t("situationMonitor.mainCharacter.name", { defaultValue: "Name" }),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("situationMonitor.mainCharacter.count", {
        defaultValue: "Mentions",
      }),
      dataIndex: "count",
      key: "count",
      width: 110,
    },
  ];

  const categoryLabels: Record<SituationMonitorCategory, string> = useMemo(
    () => ({
      politics: t("situationMonitor.categories.politics", {
        defaultValue: "Politics",
      }),
      tech: t("situationMonitor.categories.tech", { defaultValue: "Tech" }),
      finance: t("situationMonitor.categories.finance", {
        defaultValue: "Finance",
      }),
      gov: t("situationMonitor.categories.gov", { defaultValue: "Government" }),
      ai: t("situationMonitor.categories.ai", { defaultValue: "AI" }),
      intel: t("situationMonitor.categories.intel", { defaultValue: "Intel" }),
    }),
    [t],
  );

  const clusterItemsPerCategory = 6;
  const alertsPerPanel = screens.lg ? 10 : 6;
  const fedNewsPerPanel = screens.lg ? 8 : 5;
  const telegramItemsPerPanel = screens.lg ? 14 : 10;
  const orefAlertsPerPanel = screens.lg ? 12 : 8;
  const orefHistoryPerPanel = screens.lg ? 6 : 4;

  const telegramTopicOptions = useMemo(() => {
    const dynamicTopics = new Set<string>(TELEGRAM_TOPIC_PRESETS);
    for (const item of telegramFeed?.items ?? []) {
      const topic = typeof item.topic === "string" ? item.topic.trim() : "";
      if (topic) {
        dynamicTopics.add(topic);
      }
    }
    if (telegramTopicFilter !== "all") {
      dynamicTopics.add(telegramTopicFilter);
    }

    return [
      {
        label: t("situationMonitor.telegram.filters.allTopics", {
          defaultValue: "All topics",
        }),
        value: "all",
      },
      ...Array.from(dynamicTopics)
        .sort((a, b) => a.localeCompare(b))
        .map((topic) => ({ label: topic, value: topic })),
    ];
  }, [telegramFeed?.items, telegramTopicFilter, t]);

  const telegramChannelOptions = useMemo(() => {
    const channels = new Set<string>();
    for (const item of telegramFeed?.items ?? []) {
      const channel =
        typeof item.channel === "string" ? item.channel.trim() : "";
      if (channel) {
        channels.add(channel);
      }
    }
    if (telegramChannelFilter !== "all") {
      channels.add(telegramChannelFilter);
    }

    return [
      {
        label: t("situationMonitor.telegram.filters.allChannels", {
          defaultValue: "All channels",
        }),
        value: "all",
      },
      ...Array.from(channels)
        .sort((a, b) => a.localeCompare(b))
        .map((channel) => ({ label: channel, value: channel })),
    ];
  }, [telegramChannelFilter, telegramFeed?.items, t]);

  const updatedAt = data?.generatedAt ? dayjs(data.generatedAt).toDate() : null;
  const globalTelegramTooltip = t("situationMonitor.shared.telegramTooltip", {
    defaultValue:
      "Global shared Telegram signal feed. All signed-in users with items.read access see the same source and updates.",
  });
  const globalOrefTooltip = t("situationMonitor.shared.orefTooltip", {
    defaultValue:
      "Global shared OREF alert feed. All signed-in users with items.read access see the same source and updates.",
  });
  const internalFeedTooltip = t("situationMonitor.feeds.internalTooltip", {
    defaultValue: "Processed internal headlines from this project.",
  });
  const gdeltFeedTooltip = t("situationMonitor.feeds.gdeltTooltip", {
    defaultValue:
      "Fallback headlines from GDELT when internal coverage is thin.",
  });
  const marketsSnapshot = data?.markets;
  const cryptoSnapshot = data?.crypto;
  const fedSnapshot = data?.fed;
  const hasMarketSnapshotData = Boolean(
    marketsSnapshot &&
      (marketsSnapshot.indices?.length ?? 0) +
        (marketsSnapshot.sectors?.length ?? 0) +
        (marketsSnapshot.commodities?.length ?? 0) >
        0,
  );
  const hasFedIndicatorSnapshotData =
    (fedSnapshot?.indicators?.length ?? 0) > 0;

  const layout = useSituationMonitorLayoutStore((state) => state.layout);
  const responsiveLayouts = useSituationMonitorLayoutStore(
    (state) => state.layouts,
  );
  const visibility = useSituationMonitorLayoutStore(
    (state) => state.visibility,
  );
  const setLayout = useSituationMonitorLayoutStore((state) => state.setLayout);
  const setPanelVisible = useSituationMonitorLayoutStore(
    (state) => state.setPanelVisible,
  );
  const applyPreset = useSituationMonitorLayoutStore(
    (state) => state.applyPreset,
  );
  const resetPanels = useSituationMonitorLayoutStore((state) => state.reset);
  const ensurePanels = useSituationMonitorLayoutStore((state) => state.ensure);

  const [panelsOpen, setPanelsOpen] = useState(false);
  const resetLayoutOnPreset = useSituationMonitorSettingsStore(
    (state) => state.resetLayoutOnPreset,
  );
  const setResetLayoutOnPreset = useSituationMonitorSettingsStore(
    (state) => state.setResetLayoutOnPreset,
  );

  const activePreset = useMemo(() => {
    return (
      SITUATION_MONITOR_PRESETS.find((preset) =>
        isVisibilityMatchingPreset(visibility, preset.panels),
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

  const resolvedLayouts = useMemo(
    () => ({
      lg: layout.map((item) => ({ ...item })),
      md: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "md"),
        responsiveLayouts.md ?? [],
      ),
      sm: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "sm"),
        responsiveLayouts.sm ?? [],
      ),
      xs: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "xs"),
        responsiveLayouts.xs ?? [],
      ),
      xxs: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "xxs"),
        responsiveLayouts.xxs ?? [],
      ),
    }),
    [layout, responsiveLayouts],
  );

  const visibleLayout = useMemo(
    () =>
      stretchCorrelationToMonitorArea(
        filterVisibleLayoutItems(resolvedLayouts.lg, visibility),
      ),
    [resolvedLayouts.lg, visibility],
  );

  const inferredGridBreakpoint = useMemo<GridBreakpoint>(() => {
    if (screens.lg) {
      return "lg";
    }
    if (screens.md) {
      return "md";
    }
    if (screens.sm) {
      return "sm";
    }
    if (screens.xs) {
      return "xs";
    }
    return "xxs";
  }, [screens.lg, screens.md, screens.sm, screens.xs]);

  const [gridBreakpoint, setGridBreakpoint] = useState<GridBreakpoint>(
    inferredGridBreakpoint,
  );
  const [desktopLayoutEdit, setDesktopLayoutEdit] = useState(false);

  useEffect(() => {
    setGridBreakpoint(inferredGridBreakpoint);
  }, [inferredGridBreakpoint]);

  const isCompactGrid =
    gridBreakpoint === "sm" ||
    gridBreakpoint === "xs" ||
    gridBreakpoint === "xxs";
  const [compactLayoutEdit, setCompactLayoutEdit] = useState(false);
  const [layoutPreviewItem, setLayoutPreviewItem] = useState<Layout | null>(
    null,
  );

  useEffect(() => {
    if (!isCompactGrid) {
      setCompactLayoutEdit(false);
    }
  }, [isCompactGrid]);

  useEffect(() => {
    if (isCompactGrid) {
      setDesktopLayoutEdit(false);
    }
  }, [isCompactGrid]);

  useEffect(() => {
    setLayoutPreviewItem(null);
  }, [gridBreakpoint]);

  const handleGridBreakpointChange = useCallback((next: string) => {
    if (next in GRID_COLS) {
      const breakpoint = next as GridBreakpoint;
      setGridBreakpoint(breakpoint);
    }
  }, []);

  const canEditLayout = isCompactGrid ? compactLayoutEdit : desktopLayoutEdit;
  const toggleLayoutEdit = useCallback(() => {
    if (isCompactGrid) {
      setCompactLayoutEdit((prev) => !prev);
      return;
    }
    setDesktopLayoutEdit((prev) => !prev);
  }, [isCompactGrid]);

  const gridMetrics = GRID_LAYOUT_METRICS[gridBreakpoint];
  const gridMargin = gridMetrics.margin;

  useEffect(() => {
    if (!canEditLayout) {
      setLayoutPreviewItem(null);
    }
  }, [canEditLayout]);

  const gridLayouts = useMemo(
    () => ({
      lg: visibleLayout.map((item) => ({ ...item })),
      md: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "md"),
        filterVisibleLayoutItems(resolvedLayouts.md, visibility),
      ),
      sm: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "sm"),
        filterVisibleLayoutItems(resolvedLayouts.sm, visibility),
      ),
      xs: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "xs"),
        filterVisibleLayoutItems(resolvedLayouts.xs, visibility),
      ),
      xxs: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "xxs"),
        filterVisibleLayoutItems(resolvedLayouts.xxs, visibility),
      ),
    }),
    [
      resolvedLayouts.md,
      resolvedLayouts.sm,
      resolvedLayouts.xs,
      resolvedLayouts.xxs,
      visibility,
      visibleLayout,
    ],
  );

  const activeGridLayout = useMemo(() => {
    const baseLayout = gridLayouts[gridBreakpoint] ?? gridLayouts.lg ?? [];
    return layoutPreviewItem
      ? mergePanelLayouts(baseLayout, [layoutPreviewItem])
      : baseLayout;
  }, [gridBreakpoint, gridLayouts, layoutPreviewItem]);

  const activeGridLayoutMap = useMemo(
    () => new Map(activeGridLayout.map((item) => [item.i, item])),
    [activeGridLayout],
  );

  const handleLayoutChange = useCallback(
    (nextLayout: Layout[], options?: { source?: "drag" | "resize" }) => {
      const currentLayout =
        resolvedLayouts[gridBreakpoint] ?? resolvedLayouts.lg;
      const currentVisibleLayout = filterVisibleLayoutItems(
        currentLayout,
        visibility,
      );
      const nextVisibleLayout = mergePanelLayouts(
        currentVisibleLayout,
        nextLayout,
      );
      const stabilizedVisibleLayout =
        options?.source === "drag" && gridBreakpoint === "lg"
          ? stabilizeDesktopDragLayout(currentVisibleLayout, nextVisibleLayout)
          : nextVisibleLayout;

      setLayout(
        mergePanelLayouts(currentLayout, stabilizedVisibleLayout),
        gridBreakpoint,
      );
      setLayoutPreviewItem(null);
    },
    [gridBreakpoint, resolvedLayouts, setLayout, visibility],
  );

  const handleResetPanelSize = useCallback(
    (panelId: SituationMonitorPanelId) => {
      const defaultLayout = getDefaultPanelLayoutForBreakpoint(
        panelId,
        gridBreakpoint,
      );
      if (!defaultLayout) {
        return;
      }

      const currentLayout =
        resolvedLayouts[gridBreakpoint] ?? resolvedLayouts.lg;
      const currentPanelLayout = currentLayout.find(
        (item) => item.i === panelId,
      );
      if (!currentPanelLayout) {
        return;
      }

      const nextLayoutItem: Layout = {
        ...currentPanelLayout,
        w: defaultLayout.w,
        h: defaultLayout.h,
        minW: defaultLayout.minW,
        minH: defaultLayout.minH,
        maxW: defaultLayout.maxW,
        maxH: defaultLayout.maxH,
      };

      if (
        typeof nextLayoutItem.x === "number" &&
        nextLayoutItem.x + nextLayoutItem.w > GRID_COLS[gridBreakpoint]
      ) {
        nextLayoutItem.x = Math.max(
          0,
          GRID_COLS[gridBreakpoint] - nextLayoutItem.w,
        );
      }

      setLayout(
        mergePanelLayouts(currentLayout, [nextLayoutItem]),
        gridBreakpoint,
      );
      setLayoutPreviewItem(null);
    },
    [gridBreakpoint, resolvedLayouts, setLayout],
  );

  const layoutHint = canEditLayout
    ? t("situationMonitor.panels.hint", {
        defaultValue:
          "Drag cards by their headers, pull the bottom edge to change height, use the corner handle for width and height together, and restore a card's default size from its edit badge.",
      })
    : isCompactGrid
      ? t("situationMonitor.panels.hintCompact", {
          defaultValue:
            "Enable Customize layout on smaller screens before dragging or resizing cards.",
        })
      : t("situationMonitor.panels.hintDesktop", {
          defaultValue:
            "Click Customize layout to resize, reorder, and emphasize the cards you care about.",
        });

  const gridClassName = [
    "layout",
    "sm-layout-grid",
    isCompactGrid ? "sm-layout-grid--compact" : null,
    canEditLayout ? "sm-layout-grid--editing" : "sm-layout-grid--readonly",
  ]
    .filter(Boolean)
    .join(" ");

  const initialLoading = loading && !data;

  const renderHeadlineSummary = (entry: SituationMonitorHeadline) => {
    const rawSummary = translateToZh
      ? (entry.summaryZh ?? entry.summary)
      : entry.summary;
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
          .filter(
            (topic) => typeof topic === "string" && topic.trim().length > 0,
          )
          .slice(0, limit)
      : [];
    if (topics.length === 0) return null;
    return topics.map((topic) => (
      <Tag
        key={`${entry.id}:${topic}`}
        color="default"
        className="cursor-pointer"
        onClick={() =>
          window.open(
            `/search?q=${encodeURIComponent(topic)}`,
            "_blank",
            "noopener,noreferrer",
          )
        }
      >
        {topic}
      </Tag>
    ));
  };

  const renderHeadlineDetails = (entry: SituationMonitorHeadline) => {
    const summarySource = translateToZh
      ? (entry.summaryZh ?? entry.summary)
      : entry.summary;
    const summary =
      typeof summarySource === "string" ? summarySource.trim() : "";

    const keyPointsSource = translateToZh
      ? (entry.keyPointsZh ?? entry.keyPoints)
      : entry.keyPoints;
    const keyPoints = Array.isArray(keyPointsSource)
      ? keyPointsSource
          .filter(
            (point) => typeof point === "string" && point.trim().length > 0,
          )
          .slice(0, 5)
      : [];
    const topics = Array.isArray(entry.topics)
      ? entry.topics
          .filter(
            (topic) => typeof topic === "string" && topic.trim().length > 0,
          )
          .slice(0, 12)
      : [];

    if (!summary && keyPoints.length === 0 && topics.length === 0) {
      return null;
    }

    const title = t("situationMonitor.headlines.summary", {
      defaultValue: "Summary",
    });

    return (
      <Popover
        trigger="click"
        placement="left"
        title={title}
        content={
          <Space direction="vertical" size={8} style={{ maxWidth: 420 }}>
            {summary ? (
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                {summary}
              </Typography.Paragraph>
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
                      window.open(
                        `/search?q=${encodeURIComponent(topic)}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
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
    const title = t("situationMonitor.headlines.openItem", {
      defaultValue: "Open item",
    });
    return (
      <Button
        size="small"
        type="text"
        icon={<FileSearchOutlined />}
        aria-label={title}
        onClick={() =>
          window.open(
            `/items/${encodeURIComponent(entry.itemMetaId!)}`,
            "_blank",
            "noopener,noreferrer",
          )
        }
      />
    );
  };

  const collectMonitorMatches = (keys: string[]) => {
    return collectMonitorMatchesForKeys(monitorMatchesByKey, keys);
  };

  const renderMonitorMatches = (keys: string[], scopeKey: string) => {
    const matches = collectMonitorMatches(keys);
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
              <Space
                key={`${scopeKey}:${match.itemKey}:${match.monitorId}`}
                size={6}
                wrap
              >
                <Tag color={monitorColorById.get(match.monitorId)}>
                  {match.monitorName}
                </Tag>
                {match.matchedTerms.map((term) => (
                  <Tag
                    key={`${match.itemKey}:${match.monitorId}:${term}`}
                    color="default"
                    className="cursor-pointer"
                    onClick={() =>
                      window.open(
                        `/search?q=${encodeURIComponent(term)}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    {term}
                  </Tag>
                ))}
                {match.reasons.map((reason) => (
                  <Tag
                    key={`${match.itemKey}:${match.monitorId}:${reason.code}`}
                    color="default"
                  >
                    {t(`situationMonitor.monitors.reason.${reason.code}`, {
                      defaultValue:
                        reason.label ||
                        getDefaultMonitorReasonLabel(reason.code),
                    })}
                  </Tag>
                ))}
              </Space>
            ))}
          </Space>
        }
      >
        <Space size={4} wrap>
          {preview.map((match) => (
            <Tag
              key={`${scopeKey}:${match.itemKey}:${match.monitorId}`}
              color={monitorColorById.get(match.monitorId)}
            >
              {match.monitorName}
            </Tag>
          ))}
          {remaining > 0 ? <Tag color="default">+{remaining}</Tag> : null}
        </Space>
      </Popover>
    );
  };

  const renderHeadlineMonitorMatches = (entry: SituationMonitorHeadline) =>
    renderMonitorMatches(
      [buildMonitorMatchKey(entry.itemMetaId, entry.link, entry.title)],
      `headline:${entry.id}`,
    );

  const renderClusterMonitorMatches = (cluster: SituationMonitorEventCluster) =>
    renderMonitorMatches(
      cluster.items.map((entry) =>
        buildMonitorMatchKey(entry.itemMetaId, entry.link, entry.title),
      ),
      `cluster:${cluster.id}`,
    );

  const renderFeedPanel = (category: SituationMonitorCategory) => {
    const clusters = data?.clusters?.[category] ?? [];
    const diagnostics = data?.diagnostics?.categories?.[category];
    const snapshotCategoryState =
      data?.externalSnapshot?.categories?.[category];
    const emptyReason =
      clusters.length > 0
        ? null
        : snapshotCategoryState?.reasonCode === "gdelt_rate_limited" ||
            rateLimitedCategories.has(category)
          ? {
              tag: t("situationMonitor.feeds.emptyReason.rateLimited", {
                defaultValue: "RATE LIMITED",
              }),
              description: t(
                "situationMonitor.feeds.emptyDescription.rateLimited",
                {
                  defaultValue:
                    "The latest external snapshot could not refresh this category because GDELT rate limited the upstream request.",
                },
              ),
            }
          : snapshotCategoryState?.reasonCode === "gdelt_request_failed" ||
              snapshotCategoryState?.reasonCode === "gdelt_invalid_response"
            ? {
                tag: t("situationMonitor.feeds.emptyReason.upstream", {
                  defaultValue: "UPSTREAM ERROR",
                }),
                description: t(
                  "situationMonitor.feeds.emptyDescription.upstream",
                  {
                    defaultValue:
                      "The latest external snapshot could not refresh this category because the upstream GDELT request failed.",
                  },
                ),
              }
            : noActiveSourcesConfigured
              ? {
                  tag: t("situationMonitor.feeds.emptyReason.unconfigured", {
                    defaultValue: "UNCONFIGURED",
                  }),
                  description: t(
                    "situationMonitor.feeds.emptyDescription.unconfigured",
                    {
                      defaultValue:
                        "This workspace has no active internal news sources for this category yet.",
                    },
                  ),
                }
              : coverageSummary?.hasOlderItemsOutsideWindow &&
                  recommendedWindowHours
                ? {
                    tag: t("situationMonitor.feeds.emptyReason.outsideWindow", {
                      defaultValue: "OUTSIDE WINDOW",
                    }),
                    description: t(
                      "situationMonitor.feeds.emptyDescription.outsideWindow",
                      {
                        defaultValue:
                          "Older content exists outside the current time window. Expand the window to inspect broader coverage.",
                      },
                    ),
                  }
                : {
                    tag: t("situationMonitor.feeds.emptyReason.noData", {
                      defaultValue: "NO DATA",
                    }),
                    description: t(
                      "situationMonitor.feeds.emptyDescription.noData",
                      {
                        defaultValue:
                          "Neither internal coverage nor the latest external snapshot produced visible event clusters for this category.",
                      },
                    ),
                  };
    return (
      <Card
        title={
          <Space size={10}>
            <span>{categoryLabels[category]}</span>
            {snapshotCategoryState?.status === "reused" ? (
              <Popover
                content={t("situationMonitor.snapshot.reusedCategoryHint", {
                  defaultValue:
                    "Showing the last successful snapshot for this category from {{time}} while the newest upstream fetch recovers.",
                  time: snapshotCategoryState.contentGeneratedAt
                    ? formatDateTime(
                        snapshotCategoryState.contentGeneratedAt,
                        locale,
                        {
                          dateStyle: "medium",
                          timeStyle: "short",
                        },
                      )
                    : "--",
                })}
              >
                <Tag
                  color={getExternalSnapshotCategoryStatusColor(
                    snapshotCategoryState.status,
                  )}
                  className="cursor-help"
                >
                  {t("situationMonitor.snapshot.reusedCategory", {
                    defaultValue: "REUSED",
                  })}
                </Tag>
              </Popover>
            ) : null}
            <Tag color="geekblue">
              {t("situationMonitor.feeds.clusterCount", {
                defaultValue: "CLUSTERS {{count}}",
                count: diagnostics?.clusterCount ?? clusters.length,
              })}
            </Tag>
            <Tag color="default">
              {t("situationMonitor.feeds.articleCount", {
                defaultValue: "ARTICLES {{count}}",
                count: diagnostics?.totalCount ?? 0,
              })}
            </Tag>
            {diagnostics ? (
              <Popover content={internalFeedTooltip}>
                <Tag color="blue" className="cursor-help">
                  {t("situationMonitor.feeds.internalCount", {
                    defaultValue: "INT {{count}}",
                    count: diagnostics.internalCount,
                  })}
                </Tag>
              </Popover>
            ) : null}
            {diagnostics ? (
              <Popover content={gdeltFeedTooltip}>
                <Tag color="purple" className="cursor-help">
                  {t("situationMonitor.feeds.externalCount", {
                    defaultValue: "EXT {{count}}",
                    count: diagnostics.gdeltFallbackCount,
                  })}
                </Tag>
              </Popover>
            ) : null}
          </Space>
        }
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        size="small"
        loading={initialLoading}
      >
        {clusters.length === 0 ? (
          <Space direction="vertical" size={4}>
            {emptyReason ? (
              <Tag color="default" style={{ width: "fit-content" }}>
                {emptyReason.tag}
              </Tag>
            ) : null}
            <Typography.Text type="secondary">
              {emptyReason?.description ??
                t("situationMonitor.feeds.empty", {
                  defaultValue: "No headlines yet.",
                })}
            </Typography.Text>
            {data?.diagnostics?.effectiveScope === "tagged" ? (
              <Typography.Text type="secondary">
                {t("situationMonitor.feeds.taggedHint", {
                  defaultValue:
                    "Tagged scope is active. Switch to All items if you want broader coverage.",
                })}
              </Typography.Text>
            ) : null}
            {recommendedWindowHours ? (
              <Button
                size="small"
                onClick={() => setWindowHours(recommendedWindowHours)}
              >
                {t("situationMonitor.actions.switchWindow", {
                  defaultValue: "Switch to {{window}}",
                  window: formatWindowOptionLabel(recommendedWindowHours),
                })}
              </Button>
            ) : null}
          </Space>
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {clusters.slice(0, clusterItemsPerCategory).map((cluster) => {
              const lead = cluster.lead;
              const href = lead.link ? safeHttpUrl(lead.link) : null;
              const leadDate = Number.isFinite(cluster.latestTimestamp)
                ? new Date(cluster.latestTimestamp)
                : null;
              const expanded = expandedClusterIds.includes(cluster.id);
              return (
                <Card
                  key={cluster.id}
                  size="small"
                  className="border border-[var(--border)]"
                >
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <Space wrap size={8}>
                      {cluster.isAlert ? (
                        <Tag color="red">
                          {t("situationMonitor.feeds.alert", {
                            defaultValue: "ALERT",
                          })}
                        </Tag>
                      ) : null}
                      {cluster.mixedSource ? (
                        <Tag color="green">
                          {t("situationMonitor.feeds.mixedCluster", {
                            defaultValue: "MIXED",
                          })}
                        </Tag>
                      ) : null}
                      <Tag color="blue">
                        {t("situationMonitor.feeds.internalCount", {
                          defaultValue: "INT {{count}}",
                          count: cluster.internalCount,
                        })}
                      </Tag>
                      <Tag color="purple">
                        {t("situationMonitor.feeds.externalCount", {
                          defaultValue: "EXT {{count}}",
                          count: cluster.externalCount,
                        })}
                      </Tag>
                      <Tag color="default">
                        {t("situationMonitor.feeds.sourcesCount", {
                          defaultValue: "{{count}} sources",
                          count: cluster.distinctSourceCount,
                        })}
                      </Tag>
                      {renderClusterMonitorMatches(cluster)}
                    </Space>

                    <Space wrap size={8}>
                      {href ? (
                        <Typography.Link
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {translateToZh
                            ? (lead.titleZh ?? lead.title)
                            : lead.title}
                        </Typography.Link>
                      ) : (
                        <Typography.Text strong>
                          {translateToZh
                            ? (lead.titleZh ?? lead.title)
                            : lead.title}
                        </Typography.Text>
                      )}
                      {renderHeadlineItemLink(lead)}
                      {renderHeadlineDetails(lead)}
                    </Space>

                    {renderHeadlineSummary(lead)}

                    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/20 px-3 py-2 dark:bg-white/[0.03]">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <Space wrap size={[8, 8]} style={{ flex: 1 }}>
                          <Typography.Text type="secondary">
                            {leadDate
                              ? formatDateTime(leadDate, locale, {
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t("situationMonitor.feeds.rawArticleCount", {
                              defaultValue: "{{count}} raw articles",
                              count: cluster.items.length,
                            })}
                          </Typography.Text>
                          {renderHeadlineTopics(lead)}
                        </Space>
                        <Button
                          size="small"
                          icon={expanded ? <DownOutlined /> : <RightOutlined />}
                          className="self-start sm:ml-3 sm:self-center"
                          data-sm-interactive
                          onPointerDown={stopSituationMonitorInteractiveEvent}
                          onMouseDown={stopSituationMonitorInteractiveEvent}
                          onClick={(event) => {
                            stopSituationMonitorInteractiveEvent(event);
                            toggleClusterExpansion(cluster.id);
                          }}
                        >
                          {expanded
                            ? t("situationMonitor.feeds.hideRawArticles", {
                                defaultValue: "Hide raw articles",
                              })
                            : t("situationMonitor.feeds.viewRawArticles", {
                                defaultValue: "View raw articles",
                              })}
                        </Button>
                      </div>
                    </div>

                    {expanded ? (
                      <List
                        size="small"
                        dataSource={cluster.items}
                        renderItem={(entry) => {
                          const rawHref = entry.link
                            ? safeHttpUrl(entry.link)
                            : null;
                          const rawDate = Number.isFinite(entry.timestamp)
                            ? new Date(entry.timestamp)
                            : null;
                          return (
                            <List.Item key={`${cluster.id}:${entry.id}`}>
                              <Space
                                direction="vertical"
                                size={2}
                                style={{ width: "100%" }}
                              >
                                <Space size={8} wrap>
                                  {entry.isAlert ? (
                                    <Tag color="red">
                                      {t("situationMonitor.feeds.alert", {
                                        defaultValue: "ALERT",
                                      })}
                                    </Tag>
                                  ) : null}
                                  {entry.origin === "gdelt" ? (
                                    <Popover content={gdeltFeedTooltip}>
                                      <Tag
                                        color="purple"
                                        className="cursor-help"
                                      >
                                        {t(
                                          "situationMonitor.notice.gdeltLabel",
                                          {
                                            defaultValue: "GDELT",
                                          },
                                        )}
                                      </Tag>
                                    </Popover>
                                  ) : (
                                    <Popover content={internalFeedTooltip}>
                                      <Tag color="blue" className="cursor-help">
                                        {t(
                                          "situationMonitor.notice.internalLabel",
                                          {
                                            defaultValue: "INT",
                                          },
                                        )}
                                      </Tag>
                                    </Popover>
                                  )}
                                  {renderHeadlineMonitorMatches(entry)}
                                  {rawHref ? (
                                    <Typography.Link
                                      href={rawHref}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {translateToZh
                                        ? (entry.titleZh ?? entry.title)
                                        : entry.title}
                                    </Typography.Link>
                                  ) : (
                                    <Typography.Text>
                                      {translateToZh
                                        ? (entry.titleZh ?? entry.title)
                                        : entry.title}
                                    </Typography.Text>
                                  )}
                                  {renderHeadlineItemLink(entry)}
                                  {renderHeadlineDetails(entry)}
                                </Space>
                                {renderHeadlineSummary(entry)}
                                <Space size={8} wrap>
                                  <Typography.Text type="secondary">
                                    {entry.source}
                                  </Typography.Text>
                                  {rawDate ? (
                                    <Typography.Text type="secondary">
                                      {formatDateTime(rawDate, locale, {
                                        month: "2-digit",
                                        day: "2-digit",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </Typography.Text>
                                  ) : null}
                                  {renderHeadlineTopics(entry)}
                                </Space>
                              </Space>
                            </List.Item>
                          );
                        }}
                      />
                    ) : null}
                  </Space>
                </Card>
              );
            })}
          </Space>
        )}
      </Card>
    );
  };

  const renderSummaryPanel = () => (
    <Card
      size="small"
      title={t("situationMonitor.summary.title", {
        defaultValue: "Summary",
      })}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space wrap size={8}>
          <Tag color="geekblue">
            {t("situationMonitor.summary.articles", {
              defaultValue: "ARTICLES {{count}}",
              count: coverageSummary?.articleCount ?? data?.analyzedItems ?? 0,
            })}
          </Tag>
          <Tag color="cyan">
            {t("situationMonitor.summary.clusters", {
              defaultValue: "CLUSTERS {{count}}",
              count: coverageSummary?.clusterCount ?? 0,
            })}
          </Tag>
          <Tag color="blue">
            {t("situationMonitor.summary.internal", {
              defaultValue: "INT {{count}}",
              count: coverageSummary?.internalAnalyzedItems ?? 0,
            })}
          </Tag>
          <Tag color="purple">
            {t("situationMonitor.summary.external", {
              defaultValue: "EXT {{count}}",
              count: coverageSummary?.externalAnalyzedItems ?? 0,
            })}
          </Tag>
          <Tag color="green">
            {t("situationMonitor.summary.mixedClusters", {
              defaultValue: "MIXED {{count}}",
              count: coverageSummary?.mixedSourceClusterCount ?? 0,
            })}
          </Tag>
        </Space>
        <Space wrap size={8}>
          <Tag color="default">{formatWindowCompactLabel(windowHours)}</Tag>
          <Tag color={getCoverageModeColor(coverageSummary?.mode ?? "empty")}>
            {getCoverageModeLabel(coverageSummary?.mode ?? "empty")}
          </Tag>
        </Space>
        <Typography.Text type="secondary">
          {t("situationMonitor.summary.caption", {
            defaultValue:
              "Internal items remain workspace-specific. External snapshot coverage is shared and server-generated.",
          })}
        </Typography.Text>
      </Space>
    </Card>
  );

  const renderCoveragePanel = () => (
    <Card
      size="small"
      title={t("situationMonitor.coverage.title", {
        defaultValue: "Coverage",
      })}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space wrap size={8}>
          <Tag
            color={getExternalSnapshotStatusColor(
              data?.externalSnapshot?.status ?? "idle",
            )}
          >
            {getExternalSnapshotStatusLabel(
              data?.externalSnapshot?.status ?? "idle",
            )}
          </Tag>
          {data?.externalSnapshot?.stale ? (
            <Tag color="volcano">
              {t("situationMonitor.snapshot.stale", {
                defaultValue: "STALE",
              })}
            </Tag>
          ) : null}
          {freshSnapshotCategoryCount > 0 ? (
            <Tag color="green">
              {t("situationMonitor.snapshot.freshCategories", {
                defaultValue: "FRESH {{count}}",
                count: freshSnapshotCategoryCount,
              })}
            </Tag>
          ) : null}
          {reusedSnapshotCategoryCount > 0 ? (
            <Tag color="gold">
              {t("situationMonitor.snapshot.reusedCategories", {
                defaultValue: "REUSED {{count}}",
                count: reusedSnapshotCategoryCount,
              })}
            </Tag>
          ) : null}
        </Space>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.visibleCategories", {
            defaultValue:
              "{{count}} / 6 categories currently have visible coverage.",
            count: coverageSummary?.visibleCategoryCount ?? 0,
          })}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.quality", {
            defaultValue:
              "Dedupe {{dedupe}}. Avg sources / cluster {{sources}}.",
            dedupe:
              coverageSummary?.dedupeRatio !== null &&
              coverageSummary?.dedupeRatio !== undefined
                ? `${(coverageSummary.dedupeRatio * 100).toFixed(1)}%`
                : "--",
            sources:
              coverageSummary?.avgSourcesPerCluster !== null &&
              coverageSummary?.avgSourcesPerCluster !== undefined
                ? coverageSummary.avgSourcesPerCluster.toFixed(1)
                : "--",
          })}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.generatedAt", {
            defaultValue: "Last snapshot: {{time}}",
            time: data?.externalSnapshot?.generatedAt
              ? formatDateTime(data.externalSnapshot.generatedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "--",
          })}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.missingCategories", {
            defaultValue: "Missing: {{categories}}",
            categories: coverageSummary?.missingCategories.length
              ? coverageSummary.missingCategories
                  .map((category) => categoryLabels[category])
                  .join(", ")
              : t("situationMonitor.coverage.noneMissing", {
                  defaultValue: "none",
                }),
          })}
        </Typography.Text>
      </Space>
    </Card>
  );

  const renderNextActionsPanel = () => (
    <Card
      size="small"
      title={t("situationMonitor.actions.title", {
        defaultValue: "Next actions",
      })}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {recommendedWindowHours ? (
          <Alert
            type="info"
            showIcon
            message={t("situationMonitor.actions.recommendedWindow", {
              defaultValue:
                "Current results are thin. Expand to {{window}} for broader context.",
              window: formatWindowOptionLabel(recommendedWindowHours),
            })}
          />
        ) : null}
        <Space wrap>
          {summaryActionItems.map((action) => (
            <Button
              key={`summary:${action.key}`}
              type={action.type}
              size="small"
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </Space>
      </Space>
    </Card>
  );

  const renderAlertsPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.alerts.title", { defaultValue: "Alerts" })}
          </span>
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
            const date = Number.isFinite(entry.timestamp)
              ? new Date(entry.timestamp)
              : null;
            return (
              <List.Item key={entry.id}>
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Space size={8} wrap>
                    <Tag
                      color={entry.severity === "critical" ? "red" : "orange"}
                    >
                      {entry.severity.toUpperCase()}
                    </Tag>
                    <Tag color="blue">{categoryLabels[entry.category]}</Tag>
                    {renderHeadlineMonitorMatches(entry)}
                    {href ? (
                      <Typography.Link
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {translateToZh
                          ? (entry.titleZh ?? entry.title)
                          : entry.title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>
                        {translateToZh
                          ? (entry.titleZh ?? entry.title)
                          : entry.title}
                      </Typography.Text>
                    )}
                    {renderHeadlineItemLink(entry)}
                    {renderHeadlineDetails(entry)}
                  </Space>
                  {renderHeadlineSummary(entry)}
                  <Space size={8} wrap>
                    <Typography.Text type="secondary">
                      {entry.source}
                    </Typography.Text>
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
                      <Typography.Text type="secondary">
                        {entry.alertKeyword}
                      </Typography.Text>
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
          {t("situationMonitor.alerts.empty", {
            defaultValue: "No alerts in the current window.",
          })}
        </Typography.Text>
      )}
    </Card>
  );

  const renderMarketsPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.markets.title", { defaultValue: "Markets" })}
          </span>
          {marketsSnapshot && !marketsSnapshot.hasFinnhubApiKey ? (
            <Tag color="default">
              {t("situationMonitor.markets.missingKey", {
                defaultValue: "API key needed",
              })}
            </Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={
        initialLoading ||
        (refreshStage === "external" && marketsSnapshot === undefined)
      }
    >
      {marketsSnapshot?.error ? (
        <Alert type="warning" showIcon message={marketsSnapshot.error} />
      ) : null}
      {marketsSnapshot ? (
        <>
          {!marketsSnapshot.hasFinnhubApiKey ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.markets.hint", {
                defaultValue:
                  "Configure the Finnhub key in System Settings > Situation Monitor > Shared financial data providers, then enable the related economic data items.",
              })}
            </Typography.Text>
          ) : null}
          {hasMarketSnapshotData ? (
            <>
              <Table
                rowKey="symbol"
                size="small"
                pagination={false}
                columns={[
                  {
                    title: t("common.name", { defaultValue: "Name" }),
                    dataIndex: "name",
                    key: "name",
                  },
                  {
                    title: t("situationMonitor.markets.price", {
                      defaultValue: "Price",
                    }),
                    dataIndex: "price",
                    key: "price",
                    width: 120,
                    render: (value: number) => formatUsd(value, locale),
                  },
                  {
                    title: t("situationMonitor.markets.changePct", {
                      defaultValue: "Change",
                    }),
                    dataIndex: "changePercent",
                    key: "changePercent",
                    width: 110,
                    render: (value: number) => (
                      <Typography.Text
                        type={
                          Number.isFinite(value) && value < 0
                            ? "danger"
                            : "success"
                        }
                      >
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
                  {
                    title: t("common.name", { defaultValue: "Name" }),
                    dataIndex: "name",
                    key: "name",
                  },
                  {
                    title: t("situationMonitor.markets.price", {
                      defaultValue: "Price",
                    }),
                    dataIndex: "price",
                    key: "price",
                    width: 120,
                    render: (value: number) => formatUsd(value, locale),
                  },
                  {
                    title: t("situationMonitor.markets.changePct", {
                      defaultValue: "Change",
                    }),
                    dataIndex: "changePercent",
                    key: "changePercent",
                    width: 110,
                    render: (value: number) => (
                      <Typography.Text
                        type={
                          Number.isFinite(value) && value < 0
                            ? "danger"
                            : "success"
                        }
                      >
                        {formatPercent(value)}
                      </Typography.Text>
                    ),
                  },
                ]}
                dataSource={(marketsSnapshot.commodities ?? []).slice(0, 3)}
              />
            </>
          ) : !marketsSnapshot.hasFinnhubApiKey ? null : (
            <Typography.Text type="secondary">
              {t("situationMonitor.markets.empty", {
                defaultValue: "No markets data yet.",
              })}
            </Typography.Text>
          )}
        </>
      ) : (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading", { defaultValue: "Loading" })
            : t("situationMonitor.markets.empty", {
                defaultValue: "No markets data yet.",
              })}
        </Typography.Text>
      )}
    </Card>
  );

  const renderCryptoPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.crypto.title", { defaultValue: "Crypto" })}
          </span>
          <Tag color="geekblue">{cryptoSnapshot?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={
        initialLoading ||
        (refreshStage === "external" && cryptoSnapshot === undefined)
      }
    >
      {!cryptoSnapshot ? (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading", { defaultValue: "Loading" })
            : t("situationMonitor.crypto.empty", {
                defaultValue: "No crypto data.",
              })}
        </Typography.Text>
      ) : cryptoSnapshot.length ? (
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            {
              title: t("common.name", { defaultValue: "Name" }),
              dataIndex: "name",
              key: "name",
            },
            {
              title: t("situationMonitor.crypto.price", {
                defaultValue: "Price",
              }),
              dataIndex: "currentPriceUsd",
              key: "currentPriceUsd",
              width: 130,
              render: (value: number) => formatUsd(value, locale),
            },
            {
              title: t("situationMonitor.crypto.change24h", {
                defaultValue: "24h",
              }),
              dataIndex: "change24hPercent",
              key: "change24hPercent",
              width: 110,
              render: (value: number) => (
                <Typography.Text
                  type={
                    Number.isFinite(value) && value < 0 ? "danger" : "success"
                  }
                >
                  {formatPercent(value)}
                </Typography.Text>
              ),
            },
          ]}
          dataSource={cryptoSnapshot}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("situationMonitor.crypto.empty", {
            defaultValue: "No crypto data.",
          })}
        </Typography.Text>
      )}
    </Card>
  );

  const renderFedPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.fed.title", {
              defaultValue: "Federal Reserve",
            })}
          </span>
          {fedSnapshot && !fedSnapshot.hasFredApiKey ? (
            <Tag color="default">FRED API</Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={
        initialLoading ||
        (refreshStage === "external" && fedSnapshot === undefined)
      }
    >
      {!fedSnapshot ? (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading", { defaultValue: "Loading" })
            : t("situationMonitor.fed.empty", {
                defaultValue: "No Federal Reserve data yet.",
              })}
        </Typography.Text>
      ) : (
        <>
          {fedSnapshot.error ? (
            <Alert type="warning" showIcon message={fedSnapshot.error} />
          ) : null}
          {!fedSnapshot.hasFredApiKey ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.fed.hint", {
                defaultValue:
                  "Configure the FRED key in System Settings > Situation Monitor > Shared financial data providers, then enable the related economic data items.",
              })}
            </Typography.Text>
          ) : null}
          {hasFedIndicatorSnapshotData ? (
            <Table
              rowKey="seriesId"
              size="small"
              pagination={false}
              columns={[
                {
                  title: t("common.name", { defaultValue: "Name" }),
                  dataIndex: "name",
                  key: "name",
                },
                {
                  title: t("situationMonitor.fed.value", {
                    defaultValue: "Value",
                  }),
                  dataIndex: "value",
                  key: "value",
                  width: 110,
                  render: (
                    value: number | null,
                    record: SituationMonitorFedIndicator,
                  ) =>
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
          ) : !fedSnapshot.hasFredApiKey ? null : (
            <Typography.Text type="secondary">
              {t("situationMonitor.fed.empty", {
                defaultValue: "No Federal Reserve data yet.",
              })}
            </Typography.Text>
          )}

          {fedSnapshot.moneyPrinter ? (
            <>
              <Divider style={{ margin: "12px 0" }} />
              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                <Space size={10} wrap>
                  <Tag
                    color={
                      fedSnapshot.moneyPrinter.changeTrillions > 0
                        ? "green"
                        : "red"
                    }
                  >
                    {getFedMoneyPrinterLabel(
                      fedSnapshot.moneyPrinter.changeTrillions > 0,
                    )}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.fed.balanceSheet", {
                      defaultValue: "Balance sheet",
                    })}
                    : {fedSnapshot.moneyPrinter.valueTrillions.toFixed(2)}T
                  </Typography.Text>
                  <Typography.Text
                    type={
                      fedSnapshot.moneyPrinter.changePercent < 0
                        ? "danger"
                        : "success"
                    }
                  >
                    {fedSnapshot.moneyPrinter.changeTrillions > 0 ? "+" : ""}
                    {(fedSnapshot.moneyPrinter.changeTrillions * 1000).toFixed(
                      0,
                    )}
                    B ({fedSnapshot.moneyPrinter.changePercent > 0 ? "+" : ""}
                    {fedSnapshot.moneyPrinter.changePercent.toFixed(2)}%)
                  </Typography.Text>
                </Space>
                <Progress
                  percent={Math.min(
                    100,
                    Math.max(0, fedSnapshot.moneyPrinter.percentOfMax),
                  )}
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
                  const date = Number.isFinite(item.timestamp)
                    ? new Date(item.timestamp)
                    : null;
                  const title = translateToZh
                    ? (item.titleZh ?? item.title)
                    : item.title;
                  const description = translateToZh
                    ? (item.descriptionZh ?? item.description)
                    : item.description;
                  const descriptionText =
                    typeof description === "string" ? description.trim() : "";
                  return (
                    <List.Item key={item.id}>
                      <Space
                        direction="vertical"
                        size={2}
                        style={{ width: "100%" }}
                      >
                        <Space size={8} wrap>
                          <Tag
                            color={item.type === "powell" ? "orange" : "blue"}
                          >
                            {translateToZh
                              ? (item.typeLabelZh ?? item.typeLabel)
                              : item.typeLabel}
                          </Tag>
                          {item.hasVideo ? (
                            <Tag color="purple">VIDEO</Tag>
                          ) : null}
                          {href ? (
                            <Typography.Link
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                            >
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
                              timeZoneName: "short",
                            }}
                            primaryStrong
                            secondaryStyle={{ fontSize: 12 }}
                          />
                          {item.isPowellRelated && item.type !== "powell" ? (
                            <Tag color="orange">POWELL</Tag>
                          ) : null}
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
          <span>
            {t("situationMonitor.leaders.title", {
              defaultValue: "World Leaders",
            })}
          </span>
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
            title: t("situationMonitor.leaders.leader", {
              defaultValue: "Leader",
            }),
            dataIndex: "name",
            key: "name",
            render: (_: string, record: SituationMonitorWorldLeader) => (
              <Space size={8}>
                {record.flag ? <span>{record.flag}</span> : null}
                <span>{record.name}</span>
                <Typography.Text type="secondary">
                  {record.country}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t("situationMonitor.leaders.mentions", {
              defaultValue: "Mentions",
            }),
            dataIndex: "matchCount",
            key: "matchCount",
            width: 110,
          },
          {
            title: t("situationMonitor.leaders.sample", {
              defaultValue: "Sample",
            }),
            dataIndex: "headlines",
            key: "headlines",
            render: (value: SituationMonitorWorldLeader["headlines"]) => {
              const first = Array.isArray(value) ? value[0] : undefined;
              const href = first?.link ? safeHttpUrl(first.link) : null;
              if (!first)
                return <Typography.Text type="secondary">—</Typography.Text>;
              const title = translateToZh
                ? (first.titleZh ?? first.title)
                : first.title;
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
        dataSource={(data?.leaders ?? []).filter(
          (leader) => leader.matchCount > 0,
        )}
      />
    </Card>
  );

  const renderSituationPanel = (
    id: SituationMonitorSituationPanel["id"],
    fallbackTitle: string,
  ) => {
    const panel =
      (data?.situations ?? []).find((entry) => entry.id === id) ?? null;
    const statusTag = panel ? (
      <Tag
        color={
          panel.level === "critical"
            ? "red"
            : panel.level === "elevated"
              ? "orange"
              : "default"
        }
      >
        {panel.status}
      </Tag>
    ) : refreshStage === "core" ? (
      <Tag color="default">
        {t("common.loading", { defaultValue: "Loading" })}
      </Tag>
    ) : null;

    return (
      <Card
        title={
          <Space size={10}>
            <span>
              {panel
                ? translateToZh
                  ? (panel.titleZh ?? panel.title)
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
            {translateToZh
              ? (panel.subtitleZh ?? panel.subtitle)
              : panel.subtitle}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">
            {refreshStage === "core"
              ? t("common.loading", { defaultValue: "Loading" })
              : t("situationMonitor.situations.empty", {
                  defaultValue: "No recent headlines.",
                })}
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
                const date = Number.isFinite(entry.timestamp)
                  ? new Date(entry.timestamp)
                  : null;
                return (
                  <List.Item key={key}>
                    <Space
                      direction="vertical"
                      size={2}
                      style={{ width: "100%" }}
                    >
                      {href ? (
                        <Typography.Link
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {translateToZh
                            ? (entry.titleZh ?? entry.title)
                            : entry.title}
                        </Typography.Link>
                      ) : (
                        <Typography.Text>
                          {translateToZh
                            ? (entry.titleZh ?? entry.title)
                            : entry.title}
                        </Typography.Text>
                      )}
                      <Space size={8} wrap>
                        <Typography.Text type="secondary">
                          {entry.source}
                        </Typography.Text>
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
              {t("situationMonitor.situations.empty", {
                defaultValue: "No recent headlines.",
              })}
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
          <span>
            {t("situationMonitor.telegram.title", {
              defaultValue: "Telegram Early Signals",
            })}
          </span>
          <Popover content={globalTelegramTooltip}>
            <Tag color="default" className="cursor-help">
              {t("situationMonitor.shared.label", { defaultValue: "GLOBAL" })}{" "}
              <InfoCircleOutlined />
            </Tag>
          </Popover>
          <Tag color="geekblue">
            {telegramFeed?.count ?? telegramFeed?.items?.length ?? 0}
          </Tag>
          {telegramFeed?.channelSet ? (
            <Tag color="cyan">{telegramFeed.channelSet}</Tag>
          ) : null}
          {telegramFeed && !telegramFeed.configured ? (
            <Tag color="default">
              {t("situationMonitor.telegram.configMissing", {
                defaultValue: "Not configured",
              })}
            </Tag>
          ) : null}
          {telegramFeed && !telegramFeed.enabled ? (
            <Tag color="orange">
              {t("situationMonitor.telegram.disabled", {
                defaultValue: "Disabled",
              })}
            </Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={signalsLoading.telegram && !telegramFeed}
    >
      {telegramFeed?.error ? (
        <Alert type="warning" showIcon message={telegramFeed.error} />
      ) : null}
      {signalErrors.telegram ? (
        <Alert
          type="warning"
          showIcon
          message={signalErrors.telegram}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Space wrap size={8} style={{ marginBottom: 10 }}>
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.filters.label", {
            defaultValue: "Filters",
          })}
        </Typography.Text>
        <Select
          size="small"
          style={{ minWidth: 150 }}
          value={telegramTopicFilter}
          options={telegramTopicOptions}
          onChange={(value) => setTelegramTopicFilter(String(value))}
        />
        <Select
          size="small"
          style={{ minWidth: 180 }}
          value={telegramChannelFilter}
          options={telegramChannelOptions}
          showSearch
          optionFilterProp="label"
          onChange={(value) => setTelegramChannelFilter(String(value))}
        />
      </Space>
      {!session?.accessToken ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.signInRequired", {
            defaultValue: "Sign in to view global Telegram signals.",
          })}
        </Typography.Text>
      ) : !canReadItems ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.permissionRequired", {
            defaultValue:
              "You need items.read permission to view global Telegram signals.",
          })}
        </Typography.Text>
      ) : !telegramFeed ? (
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading" })}
        </Typography.Text>
      ) : !telegramFeed.configured ? (
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            {t("situationMonitor.telegram.configHint", {
              defaultValue:
                "Configure Telegram authorization in Admin Settings > System Settings > Situation Monitor.",
            })}
          </Typography.Text>
          {canManageSettings ? (
            <Button size="small" href={monitoringSettingsHref}>
              {t("situationMonitor.actions.openSettings", {
                defaultValue: "Open Situation Monitor Settings",
              })}
            </Button>
          ) : null}
        </Space>
      ) : telegramFeed.items.length === 0 ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.empty", {
            defaultValue: "No Telegram signals yet.",
          })}
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
                    {item.topic ? (
                      <Tag color="default">{item.topic}</Tag>
                    ) : null}
                    {renderMonitorMatches(
                      [`telegram:${item.id}`],
                      `telegram:${item.id}`,
                    )}
                  </Space>
                  {href ? (
                    <Typography.Link
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                    >
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
          <span>
            {t("situationMonitor.oref.title", { defaultValue: "OREF Alerts" })}
          </span>
          <Popover content={globalOrefTooltip}>
            <Tag color="default" className="cursor-help">
              {t("situationMonitor.shared.label", { defaultValue: "GLOBAL" })}{" "}
              <InfoCircleOutlined />
            </Tag>
          </Popover>
          <Tag color="geekblue">{orefAlerts?.alerts?.length ?? 0}</Tag>
          <Tag color="purple">
            {t("situationMonitor.oref.history24h", {
              defaultValue: "24h {{count}}",
              count:
                orefAlerts?.historyCount24h ??
                orefHistory?.historyCount24h ??
                0,
            })}
          </Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={signalsLoading.oref && !orefAlerts}
    >
      {orefAlerts?.error ? (
        <Alert type="warning" showIcon message={orefAlerts.error} />
      ) : null}
      {signalErrors.oref ? (
        <Alert
          type="warning"
          showIcon
          message={signalErrors.oref}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {!session?.accessToken ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.oref.signInRequired", {
            defaultValue: "Sign in to view global OREF signals.",
          })}
        </Typography.Text>
      ) : !canReadItems ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.oref.permissionRequired", {
            defaultValue:
              "You need items.read permission to view global OREF signals.",
          })}
        </Typography.Text>
      ) : !orefAlerts ? (
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading" })}
        </Typography.Text>
      ) : !orefAlerts.configured ? (
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            {t("situationMonitor.oref.configHint", {
              defaultValue:
                "Configure OREF proxy auth and enable OREF polling in environment variables.",
            })}
          </Typography.Text>
          {canManageSettings ? (
            <Button size="small" href={monitoringSettingsHref}>
              {t("situationMonitor.actions.openSettings", {
                defaultValue: "Open Situation Monitor Settings",
              })}
            </Button>
          ) : null}
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {orefAlerts.alerts.length === 0 ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.oref.empty", {
                defaultValue: "No active OREF alerts.",
              })}
            </Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={orefAlerts.alerts.slice(0, orefAlertsPerPanel)}
              renderItem={(alert) => {
                const alertDate = parseOrefTimestamp(alert.alertDate);
                const alertDateText =
                  alertDate && !Number.isNaN(alertDate.getTime())
                    ? formatDateTime(alertDate, locale, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : alert.alertDate;
                const recent = isRecentOrefTimestamp(alert.alertDate);

                return (
                  <List.Item key={alert.id}>
                    <Space
                      direction="vertical"
                      size={2}
                      style={{ width: "100%" }}
                    >
                      <Space size={8} wrap>
                        <Tag color="red">
                          {translateOrefTextForLocale(alert.cat || "alert", {
                            translateToZh,
                          })}
                        </Tag>
                        <Typography.Text>
                          {translateOrefTextForLocale(alert.title, {
                            translateToZh,
                          })}
                        </Typography.Text>
                        {recent ? (
                          <Tag color="volcano">
                            {t("situationMonitor.oref.recent", {
                              defaultValue: "Recent",
                            })}
                          </Tag>
                        ) : null}
                      </Space>
                      {Array.isArray(alert.data) && alert.data.length > 0 ? (
                        <Typography.Text type="secondary">
                          {alert.data
                            .slice(0, 4)
                            .map((area) =>
                              translateOrefTextForLocale(area, {
                                translateToZh,
                              }),
                            )
                            .join(" · ")}
                        </Typography.Text>
                      ) : null}
                      {renderMonitorMatches(
                        [`oref:${alert.id}`],
                        `oref-alert:${alert.id}`,
                      )}
                      {alertDateText ? (
                        <Typography.Text type="secondary">
                          {alertDateText}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  </List.Item>
                );
              }}
            />
          )}

          {orefHistory?.history?.length ? (
            <>
              <Divider style={{ margin: "8px 0" }} />
              <Typography.Text type="secondary">
                {t("situationMonitor.oref.recentWaves", {
                  defaultValue: "Recent waves",
                })}
              </Typography.Text>
              <List
                size="small"
                dataSource={[...orefHistory.history]
                  .reverse()
                  .slice(0, orefHistoryPerPanel)}
                renderItem={(entry) => {
                  const date = parseOrefTimestamp(entry.timestamp);
                  const waveCount = (entry.alerts ?? []).reduce((sum, item) => {
                    const count =
                      Array.isArray(item.data) && item.data.length > 0
                        ? item.data.length
                        : 1;
                    return sum + count;
                  }, 0);
                  const recent = isRecentOrefTimestamp(entry.timestamp);
                  return (
                    <List.Item key={entry.timestamp}>
                      <Space
                        direction="vertical"
                        size={6}
                        style={{ width: "100%" }}
                      >
                        <Space size={8} wrap>
                          <Tag color="default">{waveCount}</Tag>
                          {recent ? (
                            <Tag color="volcano">
                              {t("situationMonitor.oref.recent", {
                                defaultValue: "Recent",
                              })}
                            </Tag>
                          ) : null}
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
                            <Typography.Text type="secondary">
                              {entry.timestamp}
                            </Typography.Text>
                          )}
                        </Space>
                        {renderMonitorMatches(
                          (entry.alerts ?? []).map(
                            (alert) =>
                              `oref-history:${entry.timestamp}:${alert.id}`,
                          ),
                          `oref-history:${entry.timestamp}`,
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
      <WarMap
        className="h-full"
        translateTarget={translateToZh ? "zh-CN" : undefined}
      />
    </Card>
  );

  const renderRealtimeSnapshotPanel = () => (
    <Card
      title={t("situationMonitor.realtimeSnapshot.title", {
        defaultValue: "Realtime Snapshot",
      })}
      className="sm-panel-card sm-realtime-snapshot-card glass-panel border border-[var(--border)] h-full"
      styles={{ body: { padding: 16 } }}
      loading={initialLoading}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {data?.pizzint ? (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space size={[8, 8]} wrap>
              <Tag
                color={
                  data.pizzint.defcon <= 2
                    ? "red"
                    : data.pizzint.defcon <= 3
                      ? "orange"
                      : "default"
                }
              >
                {t("situationMonitor.realtimeSnapshot.pizzint", {
                  defaultValue: "PizzINT",
                })}{" "}
                DEFCON {data.pizzint.defcon}
              </Tag>
              <Typography.Text type="secondary">
                {t("situationMonitor.realtimeSnapshot.updatedAt", {
                  defaultValue: "Updated",
                })}
                :{" "}
                {dayjs(data.pizzint.updatedAt).isValid()
                  ? formatDateTime(
                      dayjs(data.pizzint.updatedAt).toDate(),
                      locale,
                      {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )
                  : "—"}
              </Typography.Text>
            </Space>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.adjustedScore", {
                    defaultValue: "Adjusted",
                  })}
                </Typography.Text>
                <Typography.Text strong>
                  {data.pizzint.adjustedScore}
                </Typography.Text>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.openLocations", {
                    defaultValue: "Open locations",
                  })}
                </Typography.Text>
                <Typography.Text strong>
                  {data.pizzint.openLocations}
                </Typography.Text>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.activeSpikes", {
                    defaultValue: "Active spikes",
                  })}
                </Typography.Text>
                <Typography.Text strong>
                  {data.pizzint.activeSpikes}
                </Typography.Text>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.avgPop", {
                    defaultValue: "Avg pop",
                  })}
                </Typography.Text>
                <Typography.Text strong>{data.pizzint.avgPop}</Typography.Text>
              </div>
            </div>
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("situationMonitor.realtimeSnapshot.pizzintEmpty", {
              defaultValue: "No PizzINT snapshot in current window.",
            })}
          </Typography.Text>
        )}

        <div>
          <Typography.Text type="secondary">
            {t("situationMonitor.realtimeSnapshot.tensionsTitle", {
              defaultValue: "Top bilateral tensions",
            })}
          </Typography.Text>
          <Table
            rowKey="id"
            size="small"
            columns={tensionColumns}
            dataSource={(data?.tensions ?? []).slice(
              0,
              realtimeSnapshotTensionLimit,
            )}
            pagination={false}
            style={{ marginTop: 8 }}
            tableLayout="fixed"
            scroll={screens.md ? undefined : { x: 420 }}
            locale={{
              emptyText: t("situationMonitor.realtimeSnapshot.tensionsEmpty", {
                defaultValue: "No bilateral tension snapshots.",
              }),
            }}
          />
        </div>
      </Space>
    </Card>
  );

  const renderCorrelationPanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>
            {t("situationMonitor.correlation.title", {
              defaultValue: "Correlation Engine",
            })}
          </span>
          <Tag color="geekblue">
            {(translateToZh
              ? (data?.correlationSummary?.statusZh ??
                data?.correlationSummary?.status)
              : data?.correlationSummary?.status) ??
              t("common.loading", { defaultValue: "Loading" })}
          </Tag>
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            onClick={() => {
              setFeedbackDrawerOpen(true);
              void loadSignalCatalog();
            }}
          >
            {t("situationMonitor.narrative.reportMissed", {
              defaultValue: "Report missed",
            })}
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
            expandable={
              correlationExpandable as TableProps<EmergingPattern>["expandable"]
            }
            dataSource={data?.correlation?.emergingPatterns ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.crossSourceTitle", {
              defaultValue: "Cross-source",
            })}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={crossSourceColumns}
            expandable={
              correlationExpandable as TableProps<CrossSourceCorrelation>["expandable"]
            }
            dataSource={data?.correlation?.crossSourceCorrelations ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.momentumTitle", {
              defaultValue: "Momentum",
            })}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={momentumColumns}
            expandable={
              correlationExpandable as TableProps<MomentumSignal>["expandable"]
            }
            dataSource={data?.correlation?.momentumSignals ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.predictiveTitle", {
              defaultValue: "Predictive",
            })}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={predictiveColumns}
            expandable={
              correlationExpandable as TableProps<PredictiveSignal>["expandable"]
            }
            dataSource={data?.correlation?.predictiveSignals ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
      </Row>
    </Card>
  );

  const renderNarrativePanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>
            {t("situationMonitor.narrative.title", {
              defaultValue: "Narrative Tracker",
            })}
          </span>
          <Tag color="geekblue">
            {(translateToZh
              ? (data?.narrativeSummary?.statusZh ??
                data?.narrativeSummary?.status)
              : data?.narrativeSummary?.status) ??
              t("common.loading", { defaultValue: "Loading" })}
          </Tag>
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            onClick={() => {
              setFeedbackDrawerOpen(true);
              void loadSignalCatalog();
            }}
          >
            {t("situationMonitor.narrative.reportMissed", {
              defaultValue: "Report missed",
            })}
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
          {t("situationMonitor.narrative.crossing", {
            defaultValue: "Crossing",
          })}
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
          {t("situationMonitor.narrative.emerging", {
            defaultValue: "Emerging",
          })}
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
          <span>
            {t("situationMonitor.mainCharacter.title", {
              defaultValue: "Main Character",
            })}
          </span>
          <Tag color="geekblue">
            {(translateToZh
              ? (data?.mainCharacterSummary?.statusZh ??
                data?.mainCharacterSummary?.status)
              : data?.mainCharacterSummary?.status) ??
              t("common.empty", { defaultValue: "No data" })}
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

  const handleMonitorsChanged = useCallback(async () => {
    await load();
    await Promise.all([
      loadTelegramFeedRef.current({ silent: true }),
      loadOrefSignalsRef.current({ silent: true }),
    ]);
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleMonitorUpdate = (event: Event) => {
      if (
        getSituationMonitorMonitorsUpdatedSource(event) === "monitors-panel"
      ) {
        return;
      }
      void handleMonitorsChanged();
    };
    window.addEventListener(
      SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
      handleMonitorUpdate,
    );
    return () => {
      window.removeEventListener(
        SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
        handleMonitorUpdate,
      );
    };
  }, [handleMonitorsChanged]);

  const renderLiveNewsPanel = () => <SituationMonitorLiveNewsPanel />;
  const renderLiveWebcamsPanel = () => <SituationMonitorLiveWebcamsPanel />;
  const renderMonitorsPanel = () => (
    <SituationMonitorMonitorsPanel
      matches={allMonitorMatches}
      onChanged={handleMonitorsChanged}
    />
  );

  const renderPanel = (panelId: SituationMonitorPanelId) => {
    switch (panelId) {
      case "summary":
        return renderSummaryPanel();
      case "coverage":
        return renderCoveragePanel();
      case "next-actions":
        return renderNextActionsPanel();
      case "map":
        return renderMapPanel();
      case "realtime-snapshot":
        return renderRealtimeSnapshotPanel();
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
          t("situationMonitor.situations.venezuela", {
            defaultValue: "Venezuela Watch",
          }),
        );
      case "situation-greenland":
        return renderSituationPanel(
          "greenland",
          t("situationMonitor.situations.greenland", {
            defaultValue: "Greenland Watch",
          }),
        );
      case "situation-iran":
        return renderSituationPanel(
          "iran",
          t("situationMonitor.situations.iran", {
            defaultValue: "Iran Crisis",
          }),
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

  const renderPanelShell = (panel: { id: SituationMonitorPanelId }) => {
    const layoutItem = activeGridLayoutMap.get(panel.id);
    const estimatedHeight = layoutItem
      ? layoutItem.h * gridMetrics.rowHeight +
        Math.max(0, layoutItem.h - 1) * gridMargin[1]
      : null;
    const isPreviewingResize = layoutPreviewItem?.i === panel.id;
    const isSizeCustomized = layoutItem
      ? isPanelSizeCustomizedForBreakpoint(layoutItem, gridBreakpoint)
      : false;
    const resetPanelSizeLabel = t("situationMonitor.layout.resetPanelSize", {
      defaultValue: "Restore default size",
    });

    return (
      <div
        className="sm-layout-panel-shell h-full"
        data-panel-id={panel.id}
        key={panel.id}
      >
        {canEditLayout && layoutItem ? (
          <div
            className={[
              "sm-layout-panel-tools",
              isPreviewingResize ? "sm-layout-panel-tools--active" : null,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="sm-layout-panel-metrics">
              {t("situationMonitor.layout.sizeBadge", {
                defaultValue: "{{cols}} cols · {{rows}} rows · {{height}}px",
                cols: layoutItem.w,
                rows: layoutItem.h,
                height: estimatedHeight ?? 0,
              })}
            </span>
            {isSizeCustomized ? (
              <Button
                size="small"
                type="default"
                icon={<ReloadOutlined />}
                className="sm-layout-panel-reset"
                data-sm-interactive
                aria-label={resetPanelSizeLabel}
                title={resetPanelSizeLabel}
                onPointerDown={stopSituationMonitorInteractiveEvent}
                onMouseDown={stopSituationMonitorInteractiveEvent}
                onClick={() => handleResetPanelSize(panel.id)}
              />
            ) : null}
          </div>
        ) : null}
        {renderPanel(panel.id)}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.situationMonitor.title", {
            defaultValue: "Situation Monitor",
          })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.situationMonitor.subtitle", {
            defaultValue:
              "Correlation, narratives, and key figures across your recent items.",
          })}
        </Typography.Text>

        <Space wrap align="center" style={{ width: "100%" }}>
          <Select
            value={windowHours}
            onChange={(value) => setWindowHours(value)}
            options={[
              {
                label: t("situationMonitor.window.6h", {
                  defaultValue: "Last 6h",
                }),
                value: 6,
              },
              {
                label: t("situationMonitor.window.24h", {
                  defaultValue: "Last 24h",
                }),
                value: 24,
              },
              {
                label: t("situationMonitor.window.72h", {
                  defaultValue: "Last 72h",
                }),
                value: 72,
              },
              {
                label: t("situationMonitor.window.168h", {
                  defaultValue: "Last 7d",
                }),
                value: 168,
              },
            ]}
            style={{ width: 160 }}
          />
          <Select
            value={scope}
            onChange={(value) => setScope(value)}
            options={[
              {
                label: t("situationMonitor.scope.tagged", {
                  defaultValue: "Tagged sources",
                }),
                value: "tagged",
              },
              {
                label: t("situationMonitor.scope.all", {
                  defaultValue: "All items",
                }),
                value: "all",
              },
            ]}
            style={{ width: 160 }}
          />
          <Tag color="default">{getScopeBadgeLabel(effectiveScope)}</Tag>
          <Button
            onClick={handleManualRefresh}
            loading={loading || manualRefreshPending}
          >
            {t("situationMonitor.actions.refreshPageData", {
              defaultValue: "Refresh page data",
            })}
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setPanelsOpen(true)}
          >
            {t("situationMonitor.panels.title", { defaultValue: "Panels" })}
          </Button>
          <Popover
            placement="bottom"
            content={
              <Space direction="vertical" size={6}>
                <Space wrap size={8}>
                  <Tag color="default">
                    {t("situationMonitor.shared.label", {
                      defaultValue: "GLOBAL",
                    })}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.globalSignals", {
                      defaultValue:
                        "Telegram and OREF are shared global signals. Access still requires login and items.read permission.",
                    })}
                  </Typography.Text>
                </Space>
                <Space wrap size={8}>
                  <Tag color="blue">
                    {t("situationMonitor.notice.internalLabel", {
                      defaultValue: "INT",
                    })}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.internalDescription", {
                      defaultValue:
                        "Processed internal headlines from this project.",
                    })}
                  </Typography.Text>
                  <Tag color="purple">
                    {t("situationMonitor.notice.gdeltLabel", {
                      defaultValue: "GDELT",
                    })}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.gdeltDescription", {
                      defaultValue:
                        "Fallback headlines from GDELT when internal coverage is thin.",
                    })}
                  </Typography.Text>
                </Space>
              </Space>
            }
          >
            <Button icon={<InfoCircleOutlined />}>
              {t("situationMonitor.notice.title", {
                defaultValue: "Signal legend",
              })}
            </Button>
          </Popover>
          <Button
            type={canEditLayout ? "primary" : "default"}
            icon={<DragOutlined />}
            onClick={toggleLayoutEdit}
          >
            {canEditLayout
              ? t("situationMonitor.layout.done", { defaultValue: "Done" })
              : t("situationMonitor.layout.edit", {
                  defaultValue: "Customize layout",
                })}
          </Button>
          {session?.accessToken ? (
            <Space size={6} align="center">
              {uiSync.state === "error" ? (
                uiSync.lastErrorMessage ? (
                  <Popover content={uiSync.lastErrorMessage}>
                    <Tag color="red">
                      {t("common.syncError", { defaultValue: "ERROR" })}
                    </Tag>
                  </Popover>
                ) : (
                  <Tag color="red">
                    {t("common.syncError", { defaultValue: "ERROR" })}
                  </Tag>
                )
              ) : uiSync.state === "syncing" ? (
                <Tag color="processing">
                  {t("common.syncing", { defaultValue: "SYNCING" })}
                </Tag>
              ) : uiSync.state === "loading" ? (
                <Tag color="processing">
                  {t("common.loading", { defaultValue: "LOADING" })}
                </Tag>
              ) : (
                <Tag color="green">
                  {t("common.synced", { defaultValue: "SYNCED" })}
                </Tag>
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
                  ? t("situationMonitor.realtime.connected", {
                      defaultValue: "RT ON",
                    })
                  : t("situationMonitor.realtime.disconnected", {
                      defaultValue: "RT OFF",
                    })}
              </Tag>
              {!realtimeState.connected && realtimeState.error ? (
                <Popover content={realtimeState.error}>
                  <Tag color="orange">
                    {t("situationMonitor.realtime.error", {
                      defaultValue: "RT ERROR",
                    })}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
          ) : null}
          <Space size={8} align="center">
            <Switch
              checked={autoRefresh}
              onChange={(checked) => setAutoRefresh(checked)}
            />
            <Typography.Text type="secondary">
              {t("situationMonitor.autoRefresh", {
                defaultValue: "Auto refresh",
              })}
            </Typography.Text>
          </Space>
          <Space size={8} align="center">
            <Switch
              checked={translateToZh}
              onChange={(checked) => setTranslateToZh(checked)}
            />
            <Typography.Text type="secondary">
              {t("situationMonitor.translateToZh", {
                defaultValue: "Translate to Simplified Chinese",
              })}
            </Typography.Text>
          </Space>
          {translateToZh && data?.translation && !data.translation.applied ? (
            data.translation.error ? (
              <Popover content={data.translation.error}>
                <Tag color="red">
                  {t("situationMonitor.translateError", {
                    defaultValue: "TRANSLATION ERROR",
                  })}
                </Tag>
              </Popover>
            ) : (
              <Tag color="red">
                {t("situationMonitor.translateError", {
                  defaultValue: "TRANSLATION ERROR",
                })}
              </Tag>
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
                  minute: "2-digit",
                }),
              })}
            </Typography.Text>
          ) : null}
          {refreshStage !== "idle" ? (
            <Tag color="processing">
              {refreshStage === "core"
                ? t("situationMonitor.refresh.core", {
                    defaultValue: "Refreshing core",
                  })
                : t("situationMonitor.refresh.external", {
                    defaultValue: "Loading external",
                  })}
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

      {insightsWarnings.map((warning) => (
        <div className="mt-3" key={`${warning.source}:${warning.code}`}>
          <Alert
            type={toAlertType(warning.severity)}
            showIcon
            message={warning.message}
            description={warning.detail}
          />
        </div>
      ))}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {taggedScopeNoResults ? (
        <div className="mt-3">
          <Alert
            type="warning"
            showIcon
            message={t("situationMonitor.scopeRecovery.title", {
              defaultValue: "Tagged scope found no internal coverage.",
            })}
            description={t("situationMonitor.scopeRecovery.description", {
              defaultValue:
                "This view is limited to items tagged for situation monitoring. Switch to All items to load broader coverage.",
            })}
            action={
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  setScope("all");
                  void load({ scopeOverride: "all" });
                }}
              >
                {t("situationMonitor.scopeRecovery.action", {
                  defaultValue: "Switch to All items",
                })}
              </Button>
            }
          />
        </div>
      ) : null}
      {allScopeNoResults ? (
        <div className="mt-3">
          <Alert
            type={allScopeEmptyState?.type ?? "warning"}
            showIcon
            message={
              allScopeEmptyState?.message ??
              t("situationMonitor.empty.generic.title", {
                defaultValue: "No content is available right now.",
              })
            }
            description={
              allScopeEmptyState?.description ??
              t("situationMonitor.empty.generic.description", {
                defaultValue:
                  "There are no internal items or external snapshot headlines available for the current view.",
              })
            }
            action={
              summaryActionItems.length > 0 ? (
                <Space wrap>
                  {summaryActionItems.map((action) => (
                    <Button
                      key={`no-coverage:${action.key}`}
                      size="small"
                      type={action.type}
                      onClick={action.onClick}
                    >
                      {action.label}
                    </Button>
                  ))}
                </Space>
              ) : null
            }
          />
        </div>
      ) : null}
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
                <Button
                  size="small"
                  onClick={() => void load({ includeExternal: false })}
                >
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
          <Typography.Text type="secondary">{layoutHint}</Typography.Text>
          {isCompactGrid ? (
            <Alert
              type="info"
              showIcon
              message={t("situationMonitor.notice.title", {
                defaultValue: "Signal scope and feed legend",
              })}
              description={
                <Space direction="vertical" size={6}>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.globalSignals", {
                      defaultValue:
                        "Telegram and OREF are shared global signals. Access still requires login and items.read permission.",
                    })}
                  </Typography.Text>
                  <Space wrap size={8}>
                    <Tag color="default">
                      {t("situationMonitor.shared.label", {
                        defaultValue: "GLOBAL",
                      })}
                    </Tag>
                    <Tag color="blue">
                      {t("situationMonitor.notice.internalLabel", {
                        defaultValue: "INT",
                      })}
                    </Tag>
                    <Tag color="purple">
                      {t("situationMonitor.notice.gdeltLabel", {
                        defaultValue: "GDELT",
                      })}
                    </Tag>
                  </Space>
                </Space>
              }
            />
          ) : null}
          {isCompactGrid ? (
            <Button
              block
              type={canEditLayout ? "primary" : "default"}
              icon={<DragOutlined />}
              onClick={toggleLayoutEdit}
            >
              {canEditLayout
                ? t("situationMonitor.layout.done", { defaultValue: "Done" })
                : t("situationMonitor.layout.edit", {
                    defaultValue: "Customize layout",
                  })}
            </Button>
          ) : null}
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space size={8} wrap>
              <Typography.Text>
                {t("situationMonitor.presets.title", {
                  defaultValue: "Presets",
                })}
              </Typography.Text>
              {activePreset ? (
                <Tag color="geekblue">
                  {activePreset.nameKey
                    ? t(activePreset.nameKey, {
                        defaultValue: activePreset.name,
                      })
                    : activePreset.name}
                </Tag>
              ) : (
                <Tag color="default">
                  {t("situationMonitor.presets.custom", {
                    defaultValue: "Custom",
                  })}
                </Tag>
              )}
            </Space>
            <Space size={8} wrap>
              <Switch
                checked={resetLayoutOnPreset}
                onChange={(checked) => setResetLayoutOnPreset(checked)}
              />
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
                      onClick={() =>
                        applyPreset(preset.id, {
                          resetLayout: resetLayoutOnPreset,
                        })
                      }
                    >
                      {t("common.apply", { defaultValue: "Apply" })}
                    </Button>,
                  ]}
                >
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      {preset.nameKey
                        ? t(preset.nameKey, { defaultValue: preset.name })
                        : preset.name}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {preset.descriptionKey
                        ? t(preset.descriptionKey, {
                            defaultValue: preset.description,
                          })
                        : preset.description}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Space>
          <Space wrap>
            <Button onClick={() => resetPanels()}>
              {t("situationMonitor.panels.reset", {
                defaultValue: "Reset panels",
              })}
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
                    {panel.titleKey
                      ? t(panel.titleKey, { defaultValue: panel.title })
                      : panel.title}
                  </Typography.Text>
                  {panel.locked ? (
                    <Tag color="default">
                      {t("situationMonitor.panels.fixed", {
                        defaultValue: "Fixed",
                      })}
                    </Tag>
                  ) : null}
                </Space>
              </List.Item>
            )}
          />
        </Space>
      </Drawer>

      <Drawer
        title={t("situationMonitor.narrative.reportMissed", {
          defaultValue: "Report missed",
        })}
        open={feedbackDrawerOpen}
        onClose={() => setFeedbackDrawerOpen(false)}
        width={screens.md ? 420 : "100%"}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("situationMonitor.narrative.reportMissedHint", {
              defaultValue:
                "Pick a headline that should have triggered a narrative/correlation signal, then choose the expected signal.",
            })}
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              {t("situationMonitor.narrative.missedHeadline", {
                defaultValue: "Headline",
              })}
            </Typography.Text>
            <Select
              showSearch
              value={missedHeadlineId || undefined}
              placeholder={t(
                "situationMonitor.narrative.missedHeadlinePlaceholder",
                { defaultValue: "Select a headline" },
              )}
              options={feedbackCandidateHeadlines.map((headline) => ({
                value: headline.id,
                label: `${headline.source} · ${translateToZh ? (headline.titleZh ?? headline.title) : headline.title}`,
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
                const title = translateToZh
                  ? (headline.titleZh ?? headline.title)
                  : headline.title;
                const date = Number.isFinite(headline.timestamp)
                  ? new Date(headline.timestamp)
                  : null;
                return (
                  <Space
                    direction="vertical"
                    size={6}
                    style={{ width: "100%" }}
                  >
                    {href ? (
                      <Typography.Link
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>{title}</Typography.Text>
                    )}
                    <Space size={8} wrap>
                      <Typography.Text type="secondary">
                        {headline.source}
                      </Typography.Text>
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
                      <Tag color="blue">
                        {categoryLabels[headline.category]}
                      </Tag>
                    </Space>
                    {renderHeadlineSummary(headline)}
                  </Space>
                );
              })()}
            </Card>
          ) : null}
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              {t("situationMonitor.narrative.missedSignalType", {
                defaultValue: "Signal type",
              })}
            </Typography.Text>
            <Select
              value={missedSignalType}
              options={[
                {
                  value: "narrative",
                  label: t("situationMonitor.narrative.title", {
                    defaultValue: "Narrative",
                  }),
                },
                {
                  value: "correlation",
                  label: t("situationMonitor.correlation.title", {
                    defaultValue: "Correlation",
                  }),
                },
              ]}
              onChange={(value) => {
                setMissedSignalType(value as "narrative" | "correlation");
                setMissedSignalId("");
              }}
            />
          </Space>
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              {t("situationMonitor.narrative.missedSignal", {
                defaultValue: "Expected signal",
              })}
            </Typography.Text>
            <Select
              showSearch
              loading={catalogLoading}
              value={missedSignalId || undefined}
              placeholder={t(
                "situationMonitor.narrative.missedSignalPlaceholder",
                { defaultValue: "Select a signal" },
              )}
              options={
                (missedSignalType === "narrative"
                  ? signalCatalog?.narratives
                  : signalCatalog?.correlations
                )?.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name} · ${entry.category}`,
                })) ?? []
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
                const headline = missedHeadlineId
                  ? feedbackHeadlineById.get(missedHeadlineId)
                  : undefined;
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

      {canEditLayout ? (
        <Alert
          type="info"
          showIcon
          message={t("situationMonitor.layout.editing", {
            defaultValue: "Layout editing is on",
          })}
          description={layoutHint}
        />
      ) : null}

      {visiblePanels.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("situationMonitor.panels.none", {
            defaultValue: "No panels enabled. Open Panels to re-enable.",
          })}
        />
      ) : (
        <ResponsiveGridLayout
          className={gridClassName}
          layouts={gridLayouts}
          breakpoints={GRID_BREAKPOINTS}
          cols={GRID_COLS}
          rowHeight={gridMetrics.rowHeight}
          isResizable={canEditLayout}
          isDraggable={canEditLayout}
          resizeHandles={["s", "se"]}
          compactType="vertical"
          margin={gridMargin}
          draggableHandle=".ant-card-head"
          draggableCancel={`${SITUATION_MONITOR_INTERACTIVE_SELECTOR},.ant-btn,.ant-select,.ant-select-selector,.ant-switch,a,button,input,textarea,[role='button']`}
          onBreakpointChange={(nextBreakpoint: string) =>
            handleGridBreakpointChange(nextBreakpoint)
          }
          onDragStop={(nextLayout: Layout[]) => {
            handleLayoutChange(nextLayout, { source: "drag" });
          }}
          onResize={(
            _nextLayout: Layout[],
            _oldItem: Layout,
            nextItem: Layout,
          ) => {
            setLayoutPreviewItem({ ...nextItem });
          }}
          onResizeStop={(nextLayout: Layout[]) => {
            handleLayoutChange(nextLayout, { source: "resize" });
          }}
        >
          {visiblePanels.map((panel) => renderPanelShell(panel))}
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
              <>
                {!marketsSnapshot.hasFinnhubApiKey ? (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.markets.hint", {
                      defaultValue:
                        "Configure the Finnhub key in System Settings > Situation Monitor > Shared financial data providers, then enable the related economic data items.",
                    })}
                  </Typography.Text>
                ) : null}
                {hasMarketSnapshotData ? (
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
                ) : !marketsSnapshot.hasFinnhubApiKey ? null : (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.markets.empty", { defaultValue: "No markets data yet." })}
                  </Typography.Text>
                )}
              </>
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
                      defaultValue:
                        "Configure the FRED key in System Settings > Situation Monitor > Shared financial data providers, then enable the related economic data items.",
                    })}
                  </Typography.Text>
                ) : null}
                {hasFedIndicatorSnapshotData ? (
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
                ) : !fedSnapshot.hasFredApiKey ? null : (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.fed.empty", { defaultValue: "No Federal Reserve data yet." })}
                  </Typography.Text>
                )}

                {fedSnapshot.moneyPrinter ? (
                  <>
                    <Divider style={{ margin: "12px 0" }} />
                    <Space direction="vertical" size={6} style={{ width: "100%" }}>
                      <Space size={10} wrap>
                        <Tag color={fedSnapshot.moneyPrinter.changeTrillions > 0 ? "green" : "red"}>
                          {getFedMoneyPrinterLabel(
                            fedSnapshot.moneyPrinter.changeTrillions > 0,
                          )}
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
                    : data?.mainCharacterSummary?.status) ??
                    t("situationMonitor.status.noData", {
                      defaultValue: "NO DATA",
                    })}
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
