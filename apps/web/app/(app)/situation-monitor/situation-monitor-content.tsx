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

import { SituationMonitorMonitorsPanel } from "./situation-monitor-monitors-panel";

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

interface HeadlineRef {
  title: string;
  link: string;
  source: string;
}

interface EmergingPattern {
  id: string;
  name: string;
  category: string;
  count: number;
  level: "high" | "elevated" | "emerging";
  sources: string[];
  headlines: HeadlineRef[];
}

interface MomentumSignal {
  id: string;
  name: string;
  category: string;
  current: number;
  delta: number;
  momentum: "surging" | "rising" | "stable";
  headlines: HeadlineRef[];
}

interface PredictiveSignal {
  id: string;
  name: string;
  category: string;
  score: number;
  confidence: number;
  prediction: string;
  level: "high" | "medium" | "low";
  headlines: HeadlineRef[];
}

interface CrossSourceCorrelation {
  id: string;
  name: string;
  category: string;
  sourceCount: number;
  sources: string[];
  level: "high" | "elevated" | "emerging";
  headlines: HeadlineRef[];
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
  link: string;
  source: string;
  timestamp: number;
  category: SituationMonitorCategory;
  origin: "items" | "gdelt";
  isAlert: boolean;
  alertKeyword?: string;
  summary?: string;
  keyPoints?: string[];
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
  headlines: { title: string; link: string; source: string; timestamp: number }[];
}

interface SituationMonitorSituationPanel {
  id: "venezuela" | "greenland" | "iran";
  title: string;
  subtitle: string;
  level: "monitoring" | "elevated" | "critical";
  status: "MONITORING" | "ELEVATED" | "CRITICAL";
  headlines: { title: string; link: string; source: string; timestamp: number }[];
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
  link: string;
  description: string;
  pubDate: string;
  timestamp: number;
  type: "monetary" | "powell" | "speech" | "testimony" | "announcement";
  typeLabel: string;
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

interface NarrativeData {
  id: string;
  name: string;
  category: string;
  severity: "watch" | "emerging" | "spreading" | "disinfo";
  count: number;
  fringeCount: number;
  mainstreamCount: number;
  sources: string[];
  headlines: { title: string; link: string; source: string; timestamp: number }[];
  keywords: string[];
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
  headlines?: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  alerts?: SituationMonitorAlertHeadline[];
  leaders?: SituationMonitorWorldLeader[];
  situations?: SituationMonitorSituationPanel[];
  markets?: SituationMonitorMarketsSnapshot;
  crypto?: SituationMonitorCryptoItem[];
  fed?: SituationMonitorFedSnapshot;
  correlation?: CorrelationResults | null;
  correlationSummary?: { totalSignals: number; status: string };
  narrative?: NarrativeResults | null;
  narrativeSummary?: { total: number; status: string };
  mainCharacter?: { characters: MainCharacterEntry[]; topCharacter: MainCharacterEntry | null };
  mainCharacterSummary?: { name: string; count: number; status: string };
}

function toTagColor(level: string) {
  switch (level) {
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
  const [refreshStage, setRefreshStage] = useState<"idle" | "core" | "external">("idle");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SituationMonitorInsightsResponse | null>(null);
  const refreshIdRef = useRef(0);
  const loading = refreshStage !== "idle";

  const monitors = useSituationMonitorMonitorsStore((state) => state.monitors);
  const monitorMatches = useSituationMonitorMonitorsStore((state) => state.matches);
  const scanMonitors = useSituationMonitorMonitorsStore((state) => state.scan);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const load = useCallback(async () => {
    if (!session?.accessToken) {
      return;
    }
    const refreshId = (refreshIdRef.current += 1);
    setRefreshStage("core");
    setError(null);
    try {
      const coreResponse = await apiClient.get<SituationMonitorInsightsResponse>("situation-monitor/insights", {
        params: { windowHours, maxItems: 400, sections: "core", scope },
      });

      if (refreshIdRef.current !== refreshId) {
        return;
      }

      const coreData = coreResponse.data ?? null;
      if (coreData) {
        setData((prev) => (prev ? { ...prev, ...coreData } : coreData));
      }

      setRefreshStage("external");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (refreshIdRef.current !== refreshId) {
        return;
      }

      const externalResponse = await apiClient.get<SituationMonitorInsightsResponse>("situation-monitor/insights", {
        params: { windowHours, maxItems: 400, sections: "external", scope },
      });

      if (refreshIdRef.current !== refreshId) {
        return;
      }

      const externalData = externalResponse.data ?? null;
      if (externalData) {
        setData((prev) => (prev ? { ...prev, ...externalData } : externalData));
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
  }, [apiClient, scope, session?.accessToken, windowHours]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const monitorScanItems: Array<SituationMonitorMonitorMatch["item"]> = useMemo(() => {
    const items: Array<SituationMonitorMonitorMatch["item"]> = [];
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
      for (const [category, entries] of Object.entries(headlines) as Array<
        [SituationMonitorCategory, SituationMonitorHeadline[]]
      >) {
        for (const entry of entries) {
          add({
            title: entry.title,
            itemMetaId: entry.itemMetaId,
            link: entry.link,
            source: entry.source,
            timestamp: entry.timestamp,
            category,
            summary: entry.summary,
            keyPoints: entry.keyPoints,
            topics: entry.topics,
          });
        }
      }
    }

    for (const alert of data?.alerts ?? []) {
      add({
        title: alert.title,
        itemMetaId: alert.itemMetaId,
        link: alert.link,
        source: alert.source,
        timestamp: alert.timestamp,
        category: `alert:${alert.category}`,
        summary: alert.summary,
        keyPoints: alert.keyPoints,
        topics: alert.topics,
      });
    }

    for (const panel of data?.situations ?? []) {
      for (const entry of panel.headlines ?? []) {
        add({
          title: entry.title,
          link: entry.link,
          source: entry.source,
          timestamp: entry.timestamp,
          category: `situation:${panel.id}`,
        });
      }
    }

    return items;
  }, [data?.alerts, data?.headlines, data?.situations]);

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
      render: (value: string, record) => (
        <Space size={8}>
          <span>{value}</span>
          <Tag color={toTagColor(record.level)}>{record.level.toUpperCase()}</Tag>
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
        return href ? (
          <Typography.Link href={href} target="_blank" rel="noreferrer">
            {first.title}
          </Typography.Link>
        ) : (
          <Typography.Text>{first.title}</Typography.Text>
        );
      },
    },
  ];

  const momentumColumns: ColumnsType<MomentumSignal> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
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
      render: (value: MomentumSignal["momentum"]) => (
        <Tag color={value === "surging" ? "red" : value === "rising" ? "orange" : "default"}>
          {value.toUpperCase()}
        </Tag>
      ),
    },
  ];

  const predictiveColumns: ColumnsType<PredictiveSignal> = [
    { title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }), dataIndex: "name", key: "name" },
    { title: t("situationMonitor.correlation.score", { defaultValue: "Score" }), dataIndex: "score", key: "score", width: 90 },
    { title: t("situationMonitor.correlation.confidence", { defaultValue: "Confidence" }), dataIndex: "confidence", key: "confidence", width: 120, render: (value: number) => `${value}%` },
    { title: t("situationMonitor.correlation.prediction", { defaultValue: "Prediction" }), dataIndex: "prediction", key: "prediction" },
  ];

  const crossSourceColumns: ColumnsType<CrossSourceCorrelation> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space size={8}>
          <span>{value}</span>
          <Tag color={toTagColor(record.level)}>{record.level.toUpperCase()}</Tag>
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
        return href ? (
          <Typography.Link href={href} target="_blank" rel="noreferrer">
            {first.title}
          </Typography.Link>
        ) : (
          <Typography.Text>{first.title}</Typography.Text>
        );
      },
    },
  ];

  const narrativeColumns: ColumnsType<NarrativeData> = [
    {
      title: t("situationMonitor.narrative.name", { defaultValue: "Narrative" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space size={8}>
          <span>{value}</span>
          <Tag color={record.severity === "disinfo" ? "red" : "default"}>{record.severity.toUpperCase()}</Tag>
        </Space>
      ),
    },
    { title: t("situationMonitor.narrative.count", { defaultValue: "Count" }), dataIndex: "count", key: "count", width: 90 },
    { title: t("situationMonitor.narrative.fringe", { defaultValue: "Fringe" }), dataIndex: "fringeCount", key: "fringeCount", width: 90 },
    { title: t("situationMonitor.narrative.mainstream", { defaultValue: "Mainstream" }), dataIndex: "mainstreamCount", key: "mainstreamCount", width: 110 },
  ];

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
    () => layout.filter((item) => visibility[item.i as SituationMonitorPanelId]),
    [layout, visibility],
  );

  const handleLayoutChange = useCallback(
    (nextLayout: Layout[]) => {
      setLayout(mergePanelLayouts(layout, nextLayout));
    },
    [layout, setLayout],
  );

  const initialLoading = loading && !data;

  const renderHeadlineSummary = (entry: SituationMonitorHeadline) => {
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
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
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
    const keyPoints = Array.isArray(entry.keyPoints)
      ? entry.keyPoints
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
        className="glass-panel border border-[var(--border)] h-full"
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
                          {entry.title}
                        </Typography.Link>
                      ) : (
                        <Typography.Text>{entry.title}</Typography.Text>
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
      className="glass-panel border border-[var(--border)] h-full"
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
                          {entry.title}
                        </Typography.Link>
                      ) : (
                      <Typography.Text>{entry.title}</Typography.Text>
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
      className="glass-panel border border-[var(--border)] h-full"
      loading={initialLoading || (refreshStage === "external" && marketsSnapshot === undefined)}
    >
      {marketsSnapshot?.error ? <Alert type="warning" showIcon message={marketsSnapshot.error} /> : null}
      {marketsSnapshot ? (
        !marketsSnapshot.hasFinnhubApiKey ? (
          <Typography.Text type="secondary">
            {t("situationMonitor.markets.hint", {
              defaultValue: "Set SITUATION_MONITOR_FINNHUB_API_KEY to enable indices/sectors/commodities.",
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
      className="glass-panel border border-[var(--border)] h-full"
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
      className="glass-panel border border-[var(--border)] h-full"
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
                defaultValue: "Set SITUATION_MONITOR_FRED_API_KEY to enable indicators and money printer.",
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
                  return (
                    <List.Item key={item.id}>
                      <Space direction="vertical" size={2} style={{ width: "100%" }}>
                        <Space size={8} wrap>
                          <Tag color={item.type === "powell" ? "orange" : "blue"}>{item.typeLabel}</Tag>
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
  );

  const renderLeadersPanel = () => (
    <Card
      title={
        <Space size={10}>
          <span>{t("situationMonitor.leaders.title", { defaultValue: "World Leaders" })}</span>
          <Tag color="geekblue">{data?.leaders?.length ?? 0}</Tag>
        </Space>
      }
      className="glass-panel border border-[var(--border)] h-full"
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
              return href ? (
                <Typography.Link href={href} target="_blank" rel="noreferrer">
                  {first.title}
                </Typography.Link>
              ) : (
                <Typography.Text>{first.title}</Typography.Text>
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
            <span>{panel?.title ?? fallbackTitle}</span>
            {statusTag}
          </Space>
        }
        className="glass-panel border border-[var(--border)] h-full"
        loading={initialLoading}
      >
        {panel?.subtitle ? (
          <Typography.Text type="secondary">{panel.subtitle}</Typography.Text>
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
                          {entry.title}
                        </Typography.Link>
                      ) : (
                        <Typography.Text>{entry.title}</Typography.Text>
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

  const renderMapPanel = () => (
    <Card
      title={t("situationMonitor.map.title", { defaultValue: "Global Map" })}
      className="glass-panel border border-[var(--border)] h-full"
    >
      <WarMap />
    </Card>
  );

  const renderCorrelationPanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>{t("situationMonitor.correlation.title", { defaultValue: "Correlation Engine" })}</span>
          <Tag color="geekblue">
            {data?.correlationSummary?.status ?? t("common.loading", { defaultValue: "Loading" })}
          </Tag>
        </Space>
      }
      className="glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
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
  );

  const renderNarrativePanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>{t("situationMonitor.narrative.title", { defaultValue: "Narrative Tracker" })}</span>
          <Tag color="geekblue">{data?.narrativeSummary?.status ?? t("common.loading", { defaultValue: "Loading" })}</Tag>
        </Space>
      }
      className="glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
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
  );

  const renderMainCharacterPanel = () => (
    <Card
      title={
        <Space size={12}>
          <span>{t("situationMonitor.mainCharacter.title", { defaultValue: "Main Character" })}</span>
          <Tag color="geekblue">{data?.mainCharacterSummary?.status ?? "NO DATA"}</Tag>
        </Space>
      }
      className="glass-panel border border-[var(--border)] h-full"
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
      case "markets":
        return renderMarketsPanel();
      case "crypto":
        return renderCryptoPanel();
      case "fed":
        return renderFedPanel();
      case "leaders":
        return renderLeadersPanel();
      case "situation-venezuela":
        return renderSituationPanel("venezuela", "Venezuela Watch");
      case "situation-greenland":
        return renderSituationPanel("greenland", "Greenland Watch");
      case "situation-iran":
        return renderSituationPanel("iran", "Iran Crisis");
      case "correlation":
        return renderCorrelationPanel();
      case "narrative":
        return renderNarrativePanel();
      case "main-character":
        return renderMainCharacterPanel();
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

        <Space wrap>
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
	            {t("situationMonitor.panels", { defaultValue: "Panels" })}
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
	          <Space size={8}>
	            <Switch checked={autoRefresh} onChange={(checked) => setAutoRefresh(checked)} />
	            <Typography.Text type="secondary">
	              {t("situationMonitor.autoRefresh", { defaultValue: "Auto refresh" })}
            </Typography.Text>
          </Space>
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

      <Drawer
        title={t("situationMonitor.panels.title", { defaultValue: "Panels" })}
        open={panelsOpen}
        onClose={() => setPanelsOpen(false)}
        width={360}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("situationMonitor.panels.hint", {
              defaultValue: "Drag cards by their headers to rearrange the dashboard.",
            })}
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space size={8} wrap>
              <Typography.Text>{t("situationMonitor.presets.title", { defaultValue: "Presets" })}</Typography.Text>
              {activePreset ? (
                <Tag color="geekblue">{activePreset.name}</Tag>
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
                    <Typography.Text>{preset.name}</Typography.Text>
                    <Typography.Text type="secondary">{preset.description}</Typography.Text>
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
                  <Typography.Text>{panel.title}</Typography.Text>
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

      {visiblePanels.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("situationMonitor.panels.none", { defaultValue: "No panels enabled. Open Panels to re-enable." })}
        />
      ) : (
        <ResponsiveGridLayout
          className="layout"
          layouts={{ lg: visibleLayout }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={30}
          isResizable
          isDraggable
          margin={[16, 16]}
          draggableHandle=".ant-card-head"
          onLayoutChange={(nextLayout: Layout[]) => handleLayoutChange(nextLayout)}
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
                    defaultValue: "Set SITUATION_MONITOR_FINNHUB_API_KEY to enable indices/sectors/commodities.",
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
                      defaultValue: "Set SITUATION_MONITOR_FRED_API_KEY to enable indicators and money printer.",
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
                                <Tag color={item.type === "powell" ? "orange" : "blue"}>{item.typeLabel}</Tag>
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
                    return href ? (
                      <Typography.Link href={href} target="_blank" rel="noreferrer">
                        {first.title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>{first.title}</Typography.Text>
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
                  {data?.correlationSummary?.status ?? t("common.loading", { defaultValue: "Loading" })}
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
                  {data?.narrativeSummary?.status ?? t("common.loading", { defaultValue: "Loading" })}
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
                <Tag color="geekblue">{data?.mainCharacterSummary?.status ?? "NO DATA"}</Tag>
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
