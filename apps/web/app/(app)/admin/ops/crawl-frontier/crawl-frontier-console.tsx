"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Steps,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

type CrawlSiteExecutionMode = "layered" | "native" | "hybrid";
type CrawlFrontierRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
type CrawlFrontierNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";

type AnyRecord = Record<string, unknown>;

interface CrawlSiteProfileRecord {
  id: string;
  name: string;
  description?: string | null;
  matchHost: string;
  isActive: boolean;
  executionMode: CrawlSiteExecutionMode;
  version: number;
  config: AnyRecord;
  updatedAt: string;
}

interface CrawlSiteProfileVersionRecord {
  id: string;
  version: number;
  name: string;
  executionMode: CrawlSiteExecutionMode;
  createdAt: string;
  createdById: string;
  config?: AnyRecord;
}

interface CrawlFrontierRunRecord {
  id: string;
  seedUrl: string;
  executionMode: CrawlSiteExecutionMode;
  status: CrawlFrontierRunStatus;
  maxDepth: number;
  maxPages: number;
  pageCount: number;
  nodeCount: number;
  articleCount: number;
  failedCount: number;
  duplicateCount: number;
  lastError?: string | null;
  metadata?: AnyRecord | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  profile?: {
    id: string;
    name: string;
    matchHost: string;
  } | null;
  summary?: {
    coverageByPageType?: Record<string, number>;
    coverageByDepth?: Record<string, number>;
    candidateStats?: Record<string, number>;
    rejectionCounts?: Record<string, number>;
    judgeSummary?: AnyRecord;
    warningFlags?: string[];
    failureKind?: string | null;
    pendingLlmJudgeJobs?: number;
    rootDiagnosis?: AnyRecord | null;
    seedSummary?: AnyRecord | null;
    llmSummary?: AnyRecord | null;
    shadowSummary?: AnyRecord | null;
    repairSummary?: AnyRecord | null;
    trace?: Array<{
      key: string;
      label: string;
      status: "completed" | "active" | "warning" | "failed" | "skipped";
      detail?: string | null;
      tags?: string[];
    }>;
  } | null;
}

interface CrawlFrontierNodeRecord {
  id: string;
  runId: string;
  parentNodeId?: string | null;
  url: string;
  canonicalUrl?: string | null;
  pageType: string;
  depth: number;
  queueClass: string;
  status: CrawlFrontierNodeStatus;
  attempts: number;
  score?: number | null;
  freshnessScore?: number | null;
  crawlResultId?: string | null;
  lastError?: string | null;
  rejectionReason?: string | null;
  metadata?: AnyRecord | null;
  discoveredAt: string;
  crawledAt?: string | null;
}

interface CrawlFrontierRunDetail extends CrawlFrontierRunRecord {
  profile?: CrawlSiteProfileRecord | null;
  nodes: CrawlFrontierNodeRecord[];
}

interface CrawlFrontierNodeDetail extends CrawlFrontierNodeRecord {
  run: {
    id: string;
    seedUrl: string;
    status: CrawlFrontierRunStatus;
    executionMode: CrawlSiteExecutionMode;
    profile?: {
      id: string;
      name: string;
      matchHost: string;
      executionMode: CrawlSiteExecutionMode;
      isActive: boolean;
    } | null;
  };
  crawlResult?: {
    id: string;
    sourceUrl: string;
    fetchedAt: string;
    markdownRef: string;
    contentHash: string;
    metadata?: AnyRecord | null;
  } | null;
  article?: {
    id: string;
    url: string;
    titleGuess?: string | null;
    sourceLabel?: string | null;
    language?: string | null;
    crawlAt: string;
    metadata?: AnyRecord | null;
    llmRepair?: AnyRecord | null;
  } | null;
  processedArticle?: {
    id: string;
    status: string;
    title?: string | null;
    subtitle?: string | null;
    author?: string | null;
    source?: string | null;
    publishedAt?: string | null;
    category?: string | null;
    qualityScore?: number | null;
    llmModel?: string | null;
    llmPromptVersion?: string | null;
    language?: string | null;
    location?: string | null;
    processedAt: string;
    removedNoiseTypes?: unknown;
    topics?: unknown;
    keyPoints?: unknown;
    entities?: unknown;
    kgRelations?: unknown;
  } | null;
  repairSummary?: {
    available: boolean;
    attempted: boolean;
    applied: boolean;
    source?: string | null;
    model?: string | null;
    error?: string | null;
    missingFields: string[];
    repairedFields: string[];
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  } | null;
  extractionSummary?: {
    hasArticle: boolean;
    hasProcessedArticle: boolean;
    processedStatus?: string | null;
    qualityScore?: number | null;
    llmModel?: string | null;
    extractedFields: string[];
    missingFields: string[];
    removedNoiseTypes?: string[];
  } | null;
  llmLogFilters?: {
    judge?: Record<string, string>;
    learn?: Record<string, string>;
    repair?: Record<string, string>;
  } | null;
}

interface CrawlSiteProfilePreviewResponse {
  url: string;
  host: string;
  draft: CrawlSiteProfileRecord;
  draftMatches: boolean;
  draftMatchReason: string;
  activeMatch?: CrawlSiteProfileRecord | null;
  activeCandidates?: CrawlSiteProfileRecord[];
}

interface ProfileFormValues {
  name: string;
  description?: string;
  matchHost: string;
  isActive: boolean;
  executionMode: CrawlSiteExecutionMode;
  config: Record<string, any>;
  configJson: string;
  previewUrl?: string;
}

interface RunFormValues {
  seedUrl: string;
  profileId?: string;
  executionMode?: CrawlSiteExecutionMode;
  maxDepth?: number;
  maxPages?: number;
  keywordsText?: string;
}

interface NodeTreeRow extends CrawlFrontierNodeRecord {
  children?: NodeTreeRow[];
}

const DEFAULT_PROFILE_CONFIG: AnyRecord = {
  keywords: [],
  priorityKeywords: ["breaking", "latest", "war", "election", "markets"],
  denyKeywords: ["newsletter", "podcast", "video", "gallery", "sponsored"],
  hostScope: "registrable_domain",
  sourceTier: "tier2",
  blockedDomains: [],
  allowedHosts: [],
  allowedDomains: [],
  seedDiscovery: {
    strategy: "auto",
    mode: "robots",
    freshnessWindowHours: 168,
    maxSeedUrls: 80,
    topologyBudgetPages: 12,
    topologyBudgetDepth: 2,
    qualityThresholds: {
      minCandidates: 3,
      minArticleRatio: 0.4,
      maxNoiseRatio: 0.45,
      minFreshRatio: 0.2,
    },
  },
  layeredOptions: {
    maxDepth: 3,
    maxPages: 60,
    maxChildrenPerNode: 24,
    paginationKeepCount: 3,
    scoreThreshold: 0.35,
  },
  nativeOptions: {
    deepCrawlStrategy: { type: "auto", params: { max_depth: 3, max_pages: 60 } },
    fallbackToLayered: true,
    minAcceptedResults: 2,
    minArticleResults: 1,
  },
  llmAssist: {
    enabled: true,
    recallMode: "high_recall",
    minJudgeConfidence: 0.75,
    shadowEvaluationRuns: 3,
    candidateBudgetByPageType: { home: 24, category: 24, list: 16, article: 0 },
    autoPublishThresholds: {
      minArticleLift: 0.15,
      minNoiseReduction: 0.2,
      minJudgeConfidence: 0.75,
    },
    shadow: { role: "active", state: "candidate" },
  },
  localeScope: { locale: "", acceptLanguages: [], denyUrlPatterns: [], denyHostPatterns: [] },
  domLinkScopes: ["main", "article", "section", "[role='main']"],
  domLinkExcludeSelectors: [
    "nav",
    "header",
    "footer",
    "aside",
    ".sidebar",
    ".newsletter",
    ".podcast",
    ".video",
    ".gallery",
    ".sponsored",
  ],
  urlPatterns: { home: [], category: [], list: [], article: [], exclude: [] },
  pageTypeSignals: {
    home: { patterns: [], keywords: [] },
    category: { patterns: [], keywords: [] },
    list: { patterns: [], keywords: [] },
    article: { patterns: [], keywords: [] },
    deny: { patterns: [], keywords: ["newsletter", "podcast", "video", "gallery"] },
  },
  freshnessRules: { recentHours: 24, weekHours: 168, monthHours: 720 },
};

const runStatusColors: Record<CrawlFrontierRunStatus, string> = {
  pending: "default",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  canceled: "default",
};

const nodeStatusColors: Record<CrawlFrontierNodeStatus, string> = {
  pending: "default",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  skipped: "gold",
  canceled: "default",
};

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): AnyRecord | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function parseJsonObject(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as AnyRecord;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${label} must be valid JSON`);
  }
}

function extractErrorMessage(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response &&
    error.response.data &&
    typeof error.response.data === "object"
  ) {
    const data = error.response.data as AnyRecord;
    if (typeof data.message === "string" && data.message.trim().length > 0) {
      return data.message.trim();
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

function parseKeywords(value?: string) {
  return (value ?? "")
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formatPath(value: unknown) {
  const parts = asStringArray(value);
  return parts.length > 0 ? parts.join(" -> ") : "-";
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatNumber(value: unknown, digits = 2) {
  const parsed = asNumber(value);
  return parsed === null ? "-" : parsed.toFixed(digits);
}

function formatCountSummary(value: unknown) {
  const record = asRecord(value);
  if (!record) {
    return "-";
  }
  return Object.entries(record)
    .map(([key, entry]) => `${key}:${asNumber(entry) ?? 0}`)
    .join(" · ");
}

function uniqueStringList(...lists: Array<string[] | undefined>) {
  return Array.from(
    new Set(
      lists.flatMap((list) =>
        (list ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      ),
    ),
  );
}

function mergeProfileConfigDefaults(value?: AnyRecord | null): AnyRecord {
  const config = asRecord(value) ?? {};
  return {
    ...DEFAULT_PROFILE_CONFIG,
    ...config,
    seedDiscovery: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.seedDiscovery) ?? {}),
      ...(asRecord(config.seedDiscovery) ?? {}),
      qualityThresholds: {
        ...(asRecord(asRecord(DEFAULT_PROFILE_CONFIG.seedDiscovery)?.qualityThresholds) ?? {}),
        ...(asRecord(asRecord(config.seedDiscovery)?.qualityThresholds) ?? {}),
      },
    },
    layeredOptions: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.layeredOptions) ?? {}),
      ...(asRecord(config.layeredOptions) ?? {}),
    },
    nativeOptions: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.nativeOptions) ?? {}),
      ...(asRecord(config.nativeOptions) ?? {}),
      deepCrawlStrategy: {
        ...(asRecord(asRecord(DEFAULT_PROFILE_CONFIG.nativeOptions)?.deepCrawlStrategy) ?? {}),
        ...(asRecord(asRecord(config.nativeOptions)?.deepCrawlStrategy) ?? {}),
        params: {
          ...(asRecord(asRecord(asRecord(DEFAULT_PROFILE_CONFIG.nativeOptions)?.deepCrawlStrategy)?.params) ?? {}),
          ...(asRecord(asRecord(asRecord(config.nativeOptions)?.deepCrawlStrategy)?.params) ?? {}),
        },
      },
    },
    llmAssist: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.llmAssist) ?? {}),
      ...(asRecord(config.llmAssist) ?? {}),
      candidateBudgetByPageType: {
        ...(asRecord(asRecord(DEFAULT_PROFILE_CONFIG.llmAssist)?.candidateBudgetByPageType) ?? {}),
        ...(asRecord(asRecord(config.llmAssist)?.candidateBudgetByPageType) ?? {}),
      },
      autoPublishThresholds: {
        ...(asRecord(asRecord(DEFAULT_PROFILE_CONFIG.llmAssist)?.autoPublishThresholds) ?? {}),
        ...(asRecord(asRecord(config.llmAssist)?.autoPublishThresholds) ?? {}),
      },
      shadow: {
        ...(asRecord(asRecord(DEFAULT_PROFILE_CONFIG.llmAssist)?.shadow) ?? {}),
        ...(asRecord(asRecord(config.llmAssist)?.shadow) ?? {}),
      },
    },
    localeScope: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.localeScope) ?? {}),
      ...(asRecord(config.localeScope) ?? {}),
    },
    urlPatterns: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.urlPatterns) ?? {}),
      ...(asRecord(config.urlPatterns) ?? {}),
    },
    pageTypeSignals: {
      ...(asRecord(DEFAULT_PROFILE_CONFIG.pageTypeSignals) ?? {}),
      ...(asRecord(config.pageTypeSignals) ?? {}),
    },
  };
}

function summarizeProfileConfig(config: AnyRecord) {
  const summary: string[] = [];
  const seedDiscovery = asRecord(config.seedDiscovery);
  const llmAssist = asRecord(config.llmAssist);
  const shadow = asRecord(llmAssist?.shadow);
  if (typeof seedDiscovery?.strategy === "string") summary.push(`seed:${seedDiscovery.strategy}`);
  if (typeof seedDiscovery?.mode === "string") summary.push(`mode:${seedDiscovery.mode}`);
  if (typeof config.hostScope === "string") summary.push(String(config.hostScope));
  if (typeof config.sourceTier === "string") summary.push(String(config.sourceTier));
  if (llmAssist?.enabled === true) summary.push("llm:on");
  if (typeof llmAssist?.recallMode === "string") summary.push(`recall:${llmAssist.recallMode}`);
  if (typeof shadow?.role === "string") summary.push(`shadow:${shadow.role}`);
  if (typeof shadow?.state === "string") summary.push(`state:${shadow.state}`);
  return summary;
}

function buildProfileStatusTags(profile: CrawlSiteProfileRecord) {
  const shadow = asRecord(asRecord(profile.config.llmAssist)?.shadow);
  const tags = [
    { color: profile.isActive ? "green" : undefined, label: profile.isActive ? "active" : "inactive" },
  ];
  if (typeof shadow?.role === "string") {
    tags.push({ color: shadow.role === "shadow" ? "purple" : "blue", label: shadow.role });
  }
  if (typeof shadow?.state === "string") {
    tags.push({ color: shadow.state === "published" ? "green" : "gold", label: shadow.state });
  }
  if (asRecord(profile.config.llmAssist)?.enabled === true) {
    tags.push({ color: "cyan", label: "auto-learn" });
  }
  if (isRecord(asRecord(asRecord(profile.config.llmAssist)?.autoPublishThresholds))) {
    tags.push({ color: "geekblue", label: "auto-publish" });
  }
  return tags;
}

function buildLlmLogsHref(filters?: Record<string, string>) {
  const params = new URLSearchParams();
  params.set("panel", "llm-request-logs");
  Object.entries(filters ?? {}).forEach(([key, value]) => {
    if (value.trim().length > 0) params.set(key, value);
  });
  return `/admin/settings/ai?${params.toString()}`;
}

function buildNodeTree(nodes: CrawlFrontierNodeRecord[]) {
  const byId = new Map<string, NodeTreeRow>();
  nodes.forEach((node) => byId.set(node.id, { ...node, children: [] }));
  const roots: NodeTreeRow[] = [];
  byId.forEach((node) => {
    if (node.parentNodeId && byId.has(node.parentNodeId)) {
      byId.get(node.parentNodeId)?.children?.push(node);
      return;
    }
    roots.push(node);
  });
  return roots;
}

function collectRunDiagnostics(run: CrawlFrontierRunRecord) {
  const metadata = asRecord(run.metadata);
  const summary = asRecord(run.summary);
  const warningFlags = uniqueStringList(
    asStringArray(metadata?.warningFlags),
    asStringArray(summary?.warningFlags),
  );
  return {
    warningFlags,
    failureKind: asString(summary?.failureKind) ?? asString(metadata?.failureKind),
    runRole:
      asString(metadata?.runRole) ??
      asString(asRecord(asRecord(summary?.llmSummary)?.lifecycle)?.role),
    seedStrategy:
      asString(asRecord(summary?.seedSummary)?.strategy) ?? asString(metadata?.seedStrategy),
    seedMethod:
      asString(asRecord(summary?.seedSummary)?.method) ?? asString(metadata?.seedMethod),
    fallbackStage:
      asString(asRecord(summary?.seedSummary)?.fallbackStage) ??
      asString(metadata?.fallbackStage),
    pendingLlmJobs:
      asNumber(summary?.pendingLlmJudgeJobs) ??
      asNumber(asRecord(summary?.llmSummary)?.pendingJudgeJobs) ??
      0,
    shadowProfileId:
      asString(asRecord(summary?.shadowSummary)?.profileId) ??
      asString(metadata?.shadowProfileId),
    judgeCount:
      asNumber(asRecord(summary?.judgeSummary)?.count) ??
      asNumber(asRecord(metadata?.judgeSummary)?.count) ??
      0,
  };
}

export function CrawlFrontierConsole() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingNodeDetail, setLoadingNodeDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<CrawlSiteProfileRecord[]>([]);
  const [runs, setRuns] = useState<CrawlFrontierRunRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<CrawlFrontierRunDetail | null>(null);
  const [selectedNode, setSelectedNode] = useState<CrawlFrontierNodeDetail | null>(null);
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);
  const [nodeDrawerOpen, setNodeDrawerOpen] = useState(false);
  const [runDrawerTab, setRunDrawerTab] = useState("overview");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<CrawlSiteProfileVersionRecord[]>([]);
  const [currentVersionProfile, setCurrentVersionProfile] = useState<CrawlSiteProfileRecord | null>(null);
  const [profileEditor, setProfileEditor] = useState<{ open: boolean; editing: CrawlSiteProfileRecord | null }>({ open: false, editing: null });
  const [profileRawMode, setProfileRawMode] = useState(false);
  const [profilePreviewLoading, setProfilePreviewLoading] = useState(false);
  const [profileMatchPreview, setProfileMatchPreview] = useState<CrawlSiteProfilePreviewResponse | null>(null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runFilters, setRunFilters] = useState({
    search: "",
    profileId: undefined as string | undefined,
    status: undefined as CrawlFrontierRunStatus | undefined,
    executionMode: undefined as CrawlSiteExecutionMode | undefined,
    runRole: undefined as string | undefined,
    failureKind: undefined as string | undefined,
    warningFlag: undefined as string | undefined,
    seedStrategy: undefined as string | undefined,
  });
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [nodeQuery, setNodeQuery] = useState("");
  const [nodeStatusFilter, setNodeStatusFilter] = useState<CrawlFrontierNodeStatus | "all">("all");
  const [nodePageTypeFilter, setNodePageTypeFilter] = useState("all");
  const [nodeProblemsOnly, setNodeProblemsOnly] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [runForm] = Form.useForm<RunFormValues>();
  const watchedProfileConfig = Form.useWatch("config", profileForm);
  const watchedProfileConfigJson = Form.useWatch("configJson", profileForm);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const resolvedProfileConfig = useMemo(() => {
    if (!profileRawMode) {
      return {
        config: mergeProfileConfigDefaults(asRecord(watchedProfileConfig)),
        error: null as string | null,
      };
    }
    try {
      return {
        config: mergeProfileConfigDefaults(parseJsonObject(String(watchedProfileConfigJson ?? "{}"), "config")),
        error: null as string | null,
      };
    } catch (error) {
      return {
        config: null,
        error: error instanceof Error ? error.message : "Invalid config JSON",
      };
    }
  }, [profileRawMode, watchedProfileConfig, watchedProfileConfigJson]);

  const loadProfiles = useCallback(async () => {
    if (!canView) return;
    setLoadingProfiles(true);
    try {
      const response = await apiClient.get<CrawlSiteProfileRecord[]>("admin/crawl-frontier/profiles");
      setProfiles(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl frontier profiles", error);
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadProfiles", {
            defaultValue: "Failed to load crawl site profiles.",
          }),
        ),
      );
    } finally {
      setLoadingProfiles(false);
    }
  }, [apiClient, canView, messageApi, t]);

  const loadRuns = useCallback(async () => {
    if (!canView) return;
    setLoadingRuns(true);
    try {
      const params: Record<string, string> = {};
      if (runFilters.search.trim()) params.search = runFilters.search.trim();
      if (runFilters.profileId) params.profileId = runFilters.profileId;
      if (runFilters.status) params.status = runFilters.status;
      if (runFilters.executionMode) params.executionMode = runFilters.executionMode;
      if (runFilters.runRole) params.runRole = runFilters.runRole;
      if (runFilters.failureKind) params.failureKind = runFilters.failureKind;
      if (runFilters.warningFlag) params.warningFlag = runFilters.warningFlag;
      if (runFilters.seedStrategy) params.seedStrategy = runFilters.seedStrategy;
      const response = await apiClient.get<CrawlFrontierRunRecord[]>("admin/crawl-frontier/runs", {
        params,
      });
      setRuns(response.data ?? []);
      setSelectedRunIds([]);
    } catch (error) {
      captureClientError("Failed to load crawl frontier runs", error);
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadRuns", {
            defaultValue: "Failed to load crawl frontier runs.",
          }),
        ),
      );
    } finally {
      setLoadingRuns(false);
    }
  }, [apiClient, canView, messageApi, runFilters, t]);

  useEffect(() => {
    if (!canView) return;
    void loadProfiles();
  }, [canView, loadProfiles]);

  useEffect(() => {
    if (!canView) return;
    void loadRuns();
  }, [canView, loadRuns]);

  const resetProfileEditor = useCallback(
    (profile?: CrawlSiteProfileRecord | null) => {
      const config = mergeProfileConfigDefaults(profile?.config);
      profileForm.setFieldsValue({
        name: profile?.name ?? "",
        description: profile?.description ?? "",
        matchHost: profile?.matchHost ?? "",
        isActive: profile?.isActive ?? true,
        executionMode: profile?.executionMode ?? "layered",
        config,
        configJson: stringifyJson(config),
        previewUrl: "",
      });
      setProfileRawMode(false);
      setProfileMatchPreview(null);
    },
    [profileForm],
  );

  const openCreateProfile = () => {
    resetProfileEditor(null);
    setProfileEditor({ open: true, editing: null });
  };

  const openEditProfile = async (profile: CrawlSiteProfileRecord) => {
    setSaving(true);
    try {
      const response = await apiClient.get<CrawlSiteProfileRecord>(`admin/crawl-frontier/profiles/${profile.id}`);
      const resolved = response.data ?? profile;
      resetProfileEditor(resolved);
      setProfileEditor({ open: true, editing: resolved });
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadProfile", {
            defaultValue: "Failed to load crawl site profile.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleProfileRawModeChange = async (checked: boolean) => {
    if (checked) {
      profileForm.setFieldValue("configJson", stringifyJson(mergeProfileConfigDefaults(asRecord(watchedProfileConfig))));
      setProfileRawMode(true);
      return;
    }
    try {
      const parsed = parseJsonObject(profileForm.getFieldValue("configJson") ?? "{}", "config");
      profileForm.setFieldValue("config", mergeProfileConfigDefaults(parsed));
      setProfileRawMode(false);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "Invalid config JSON");
    }
  };

  const previewProfileMatch = async () => {
    const previewUrl = String(profileForm.getFieldValue("previewUrl") ?? "").trim();
    if (!previewUrl) {
      messageApi.warning("Enter a URL to preview profile matching.");
      return;
    }
    const matchHost = String(profileForm.getFieldValue("matchHost") ?? "").trim();
    if (!matchHost) {
      messageApi.warning("Enter a match host before previewing.");
      return;
    }
    if (!resolvedProfileConfig.config) {
      messageApi.error(resolvedProfileConfig.error ?? "Invalid config JSON");
      return;
    }
    setProfilePreviewLoading(true);
    try {
      const response = await apiClient.post<CrawlSiteProfilePreviewResponse>("admin/crawl-frontier/profiles/preview", {
        url: previewUrl,
        name: String(profileForm.getFieldValue("name") ?? "").trim() || undefined,
        matchHost,
        isActive: Boolean(profileForm.getFieldValue("isActive")),
        executionMode: profileForm.getFieldValue("executionMode") ?? "layered",
        config: resolvedProfileConfig.config,
      });
      setProfileMatchPreview(response.data ?? null);
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to preview profile match."));
    } finally {
      setProfilePreviewLoading(false);
    }
  };

  const submitProfile = async (values: ProfileFormValues) => {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        matchHost: values.matchHost.trim(),
        isActive: values.isActive,
        executionMode: values.executionMode,
        config: profileRawMode
          ? parseJsonObject(values.configJson, "config")
          : mergeProfileConfigDefaults(asRecord(values.config)),
      };
      if (profileEditor.editing) {
        await apiClient.patch(`admin/crawl-frontier/profiles/${profileEditor.editing.id}`, payload);
      } else {
        await apiClient.post("admin/crawl-frontier/profiles", payload);
      }
      messageApi.success("Crawl site profile saved.");
      setProfileEditor({ open: false, editing: null });
      await loadProfiles();
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to save crawl site profile."));
    } finally {
      setSaving(false);
    }
  };

  const openVersions = async (profile: CrawlSiteProfileRecord) => {
    setSaving(true);
    try {
      const response = await apiClient.get<CrawlSiteProfileVersionRecord[]>(`admin/crawl-frontier/profiles/${profile.id}/versions`);
      setVersions(response.data ?? []);
      setCurrentVersionProfile(profile);
      setVersionsOpen(true);
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to load crawl site profile versions."));
    } finally {
      setSaving(false);
    }
  };

  const rollbackVersion = async (profileId: string, version: number) => {
    Modal.confirm({
      title: "Rollback profile version?",
      content: "This replaces the current profile configuration with the selected historical version.",
      okText: "Rollback",
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true);
        try {
          await apiClient.post(`admin/crawl-frontier/profiles/${profileId}/rollback/${version}`);
          messageApi.success("Crawl site profile rolled back.");
          setVersionsOpen(false);
          setCurrentVersionProfile(null);
          await loadProfiles();
        } catch (error) {
          messageApi.error(extractErrorMessage(error, "Failed to roll back crawl site profile."));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const submitRun = async (values: RunFormValues) => {
    setSaving(true);
    try {
      await apiClient.post("admin/crawl-frontier/runs", {
        seedUrl: values.seedUrl.trim(),
        profileId: values.profileId || undefined,
        executionMode: values.executionMode || undefined,
        maxDepth: values.maxDepth,
        maxPages: values.maxPages,
        keywords: parseKeywords(values.keywordsText),
      });
      messageApi.success("Crawl frontier run created.");
      setRunModalOpen(false);
      runForm.resetFields();
      await loadRuns();
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to create crawl frontier run."));
    } finally {
      setSaving(false);
    }
  };

  const openRun = async (runId: string) => {
    setSaving(true);
    try {
      const response = await apiClient.get<CrawlFrontierRunDetail>(`admin/crawl-frontier/runs/${runId}`);
      setSelectedRun(response.data);
      setRunDrawerOpen(true);
      setRunDrawerTab("overview");
      setSelectedNodeIds([]);
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to load crawl frontier run."));
    } finally {
      setSaving(false);
    }
  };

  const reloadSelectedRun = async () => {
    if (!selectedRun) return;
    await openRun(selectedRun.id);
  };

  const cancelRun = async (runId: string) => {
    Modal.confirm({
      title: "Cancel crawl frontier run?",
      content: "This stops queued and running frontier expansion for the selected run.",
      okText: "Cancel run",
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true);
        try {
          await apiClient.post(`admin/crawl-frontier/runs/${runId}/cancel`);
          messageApi.success("Crawl frontier run canceled.");
          if (selectedRun?.id === runId) await reloadSelectedRun();
          await loadRuns();
        } catch (error) {
          messageApi.error(extractErrorMessage(error, "Failed to cancel crawl frontier run."));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const bulkCancelRuns = async () => {
    const ids = selectedRunIds.map((entry) => String(entry));
    if (ids.length === 0) return;
    Modal.confirm({
      title: "Cancel selected runs?",
      content: "This cancels all selected runs and stops further frontier expansion.",
      okText: "Cancel selected",
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true);
        try {
          await apiClient.post("admin/crawl-frontier/runs/cancel", { ids });
          messageApi.success(`${ids.length} runs canceled.`);
          if (selectedRun && ids.includes(selectedRun.id)) await reloadSelectedRun();
          await loadRuns();
        } catch (error) {
          messageApi.error(extractErrorMessage(error, "Failed to cancel selected runs."));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const retryNode = async (nodeId: string) => {
    setSaving(true);
    try {
      const response = await apiClient.post<CrawlFrontierRunDetail>(`admin/crawl-frontier/nodes/${nodeId}/retry`);
      setSelectedRun(response.data);
      messageApi.success("Crawl frontier node re-queued.");
      await loadRuns();
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to retry crawl frontier node."));
    } finally {
      setSaving(false);
    }
  };

  const bulkRetryNodes = async () => {
    const ids = selectedNodeIds.map((entry) => String(entry));
    if (ids.length === 0) return;
    Modal.confirm({
      title: "Retry selected nodes?",
      content: "This re-queues the selected failed or skipped nodes for another crawl attempt.",
      okText: "Retry selected",
      onOk: async () => {
        setSaving(true);
        try {
          await apiClient.post("admin/crawl-frontier/nodes/retry", { ids });
          messageApi.success(`${ids.length} nodes re-queued.`);
          await loadRuns();
          await reloadSelectedRun();
        } catch (error) {
          messageApi.error(extractErrorMessage(error, "Failed to retry selected nodes."));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const openNodeDetail = async (nodeId: string) => {
    setLoadingNodeDetail(true);
    try {
      const response = await apiClient.get<CrawlFrontierNodeDetail>(`admin/crawl-frontier/nodes/${nodeId}`);
      setSelectedNode(response.data);
      setNodeDrawerOpen(true);
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to load crawl frontier node detail."));
    } finally {
      setLoadingNodeDetail(false);
    }
  };

  const runStats = useMemo(() => {
    return runs.reduce(
      (summary, run) => {
        const diagnostics = collectRunDiagnostics(run);
        summary.total += 1;
        if (run.status === "queued" || run.status === "running") summary.active += 1;
        if (run.status === "failed") summary.failed += 1;
        if (diagnostics.warningFlags.includes("challenge_detected")) summary.challenge += 1;
        if ((diagnostics.pendingLlmJobs ?? 0) > 0) summary.pendingLlm += 1;
        if (diagnostics.seedMethod || diagnostics.seedStrategy === "seed_first") summary.seedFirst += 1;
        return summary;
      },
      { total: 0, active: 0, failed: 0, challenge: 0, pendingLlm: 0, seedFirst: 0 },
    );
  }, [runs]);

  const activeProfileCount = useMemo(() => profiles.filter((profile) => profile.isActive).length, [profiles]);
  const shadowProfileCount = useMemo(
    () =>
      profiles.filter((profile) => asRecord(asRecord(profile.config.llmAssist)?.shadow)?.role === "shadow").length,
    [profiles],
  );

  const filteredNodes = useMemo(() => {
    const nodes = selectedRun?.nodes ?? [];
    const query = nodeQuery.trim().toLowerCase();
    return nodes.filter((node) => {
      if (
        query &&
        !node.url.toLowerCase().includes(query) &&
        !formatPath(node.metadata?.discoveryPath).toLowerCase().includes(query) &&
        !formatPath(node.metadata?.frontierPath).toLowerCase().includes(query)
      ) {
        return false;
      }
      if (nodeStatusFilter !== "all" && node.status !== nodeStatusFilter) return false;
      if (nodePageTypeFilter !== "all" && node.pageType !== nodePageTypeFilter) return false;
      if (nodeProblemsOnly) {
        const warningFlags = asStringArray(asRecord(node.metadata)?.warningFlags);
        if (!node.lastError && !node.rejectionReason && warningFlags.length === 0) return false;
      }
      return true;
    });
  }, [nodePageTypeFilter, nodeProblemsOnly, nodeQuery, nodeStatusFilter, selectedRun?.nodes]);

  const selectedRunDiagnostics = selectedRun ? collectRunDiagnostics(selectedRun) : null;
  const selectedRunSummary = selectedRun?.summary ?? null;
  const selectedNodesTree = useMemo(() => buildNodeTree(filteredNodes), [filteredNodes]);

  const profileColumns: ColumnsType<CrawlSiteProfileRecord> = [
    {
      title: "Profile",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary">{record.description || record.matchHost}</Typography.Text>
        </Space>
      ),
    },
    { title: "Match Host", dataIndex: "matchHost", key: "matchHost", width: 220 },
    {
      title: "Mode / Status",
      key: "mode",
      render: (_, record) => (
        <Space wrap size={[4, 4]}>
          <Tag>{record.executionMode}</Tag>
          {buildProfileStatusTags(record).map((entry) => (
            <Tag key={`${record.id}-${entry.label}`} color={entry.color}>
              {entry.label}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "Strategy",
      key: "config",
      render: (_, record) => (
        <Space wrap size={[4, 4]}>
          {summarizeProfileConfig(record.config).map((entry) => (
            <Tag key={`${record.id}-${entry}`}>{entry}</Tag>
          ))}
        </Space>
      ),
    },
    { title: "Version", dataIndex: "version", key: "version", width: 90 },
    {
      title: "Actions",
      key: "actions",
      width: 180,
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => void openEditProfile(record)}>Edit</Button>
          <Button size="small" onClick={() => void openVersions(record)}>Versions</Button>
        </Space>
      ),
    },
  ];

  const runColumns: ColumnsType<CrawlFrontierRunRecord> = [
    {
      title: "Run",
      key: "seedUrl",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis style={{ maxWidth: 360 }}>{record.seedUrl}</Typography.Text>
          <Typography.Text type="secondary">{formatDateTime(record.createdAt)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "Profile",
      key: "profile",
      render: (_, record) =>
        record.profile ? (
          <Space direction="vertical" size={0}>
            <Typography.Text>{record.profile.name}</Typography.Text>
            <Typography.Text type="secondary">{record.profile.matchHost}</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">auto</Typography.Text>
        ),
    },
    { title: "Mode", key: "mode", width: 120, render: (_, record) => <Tag>{record.executionMode}</Tag> },
    { title: "Status", key: "status", width: 120, render: (_, record) => <Tag color={runStatusColors[record.status]}>{record.status}</Tag> },
    {
      title: "Coverage",
      key: "coverage",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{record.pageCount}/{record.nodeCount} pages</Typography.Text>
          <Typography.Text type="secondary">{record.articleCount} articles · {record.failedCount} failed</Typography.Text>
        </Space>
      ),
    },
    {
      title: "Diagnostics",
      key: "diagnostics",
      render: (_, record) => {
        const diagnostics = collectRunDiagnostics(record);
        return (
          <Space wrap size={[4, 4]}>
            {diagnostics.failureKind ? <Tag color="red">{diagnostics.failureKind}</Tag> : null}
            {diagnostics.runRole ? <Tag color="blue">{diagnostics.runRole}</Tag> : null}
            {diagnostics.seedStrategy ? <Tag color="green">{`seed:${diagnostics.seedStrategy}`}</Tag> : null}
            {diagnostics.seedMethod ? <Tag color="lime">{diagnostics.seedMethod}</Tag> : null}
            {diagnostics.fallbackStage ? <Tag color="gold">{diagnostics.fallbackStage}</Tag> : null}
            {diagnostics.pendingLlmJobs > 0 ? <Tag color="magenta">{`pending:${diagnostics.pendingLlmJobs}`}</Tag> : null}
            {diagnostics.shadowProfileId ? <Tag color="purple">shadow-profile</Tag> : null}
            {diagnostics.judgeCount > 0 ? <Tag color="cyan">{`judge:${diagnostics.judgeCount}`}</Tag> : null}
            {diagnostics.warningFlags.slice(0, 4).map((flag) => (
              <Tag key={`${record.id}-${flag}`} color="gold">{flag}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      width: 180,
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => void openRun(record.id)}>View</Button>
          {record.status !== "completed" && record.status !== "canceled" ? (
            <Button size="small" danger onClick={() => void cancelRun(record.id)}>Cancel</Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const nodeColumns: ColumnsType<NodeTreeRow> = [
    {
      title: "Node",
      key: "url",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space wrap size={[4, 4]}>
            <Tag>{record.pageType}</Tag>
            <Tag>{record.queueClass}</Tag>
            <Tag color={nodeStatusColors[record.status]}>{record.status}</Tag>
          </Space>
          <Typography.Text ellipsis style={{ maxWidth: 520 }}>{record.url}</Typography.Text>
          <Typography.Text type="secondary">
            discovery: {formatPath(record.metadata?.discoveryPath)} · frontier: {formatPath(record.metadata?.frontierPath)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "Judge",
      key: "judge",
      width: 200,
      render: (_, record) => {
        const metadata = asRecord(record.metadata);
        return (
          <Space wrap size={[4, 4]}>
            {asString(metadata?.judgeMethod) ? <Tag color="blue">{String(metadata?.judgeMethod)}</Tag> : null}
            {asNumber(metadata?.judgeConfidence) !== null ? <Tag color="cyan">{`conf:${formatNumber(metadata?.judgeConfidence)}`}</Tag> : null}
            {asStringArray(metadata?.selectorHints).slice(0, 2).map((hint) => (
              <Tag key={`${record.id}-${hint}`} color="purple">{hint}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: "Diagnostics",
      key: "diagnostics",
      render: (_, record) => {
        const metadata = asRecord(record.metadata);
        return (
          <Space wrap size={[4, 4]}>
            {asString(metadata?.failureKind) ? <Tag color="red">{String(metadata?.failureKind)}</Tag> : null}
            {record.rejectionReason ? <Tag color="orange">{record.rejectionReason}</Tag> : null}
            {asStringArray(metadata?.warningFlags).slice(0, 3).map((flag) => (
              <Tag key={`${record.id}-${flag}`} color="gold">{flag}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      width: 180,
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => void openNodeDetail(record.id)}>Inspect</Button>
          {record.status === "failed" || record.status === "skipped" ? (
            <Button size="small" onClick={() => void retryNode(record.id)}>Retry</Button>
          ) : null}
        </Space>
      ),
    },
  ];

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card">
        <Alert type="warning" message={t("settings.adminOnly.title")} description={t("settings.adminOnly.description")} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("crawlFrontier.title", { defaultValue: "News Crawl Frontier Console" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("crawlFrontier.subtitle", {
            defaultValue:
              "Operate site profiles, inspect seed-first and frontier traces, and debug why capture succeeded, degraded, or failed.",
          })}
        </Typography.Text>
      </Space>

      <Tabs
        items={[
          {
            key: "profiles",
            label: "Profiles",
            children: (
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={8}><Card className="content-card"><Statistic title="Profiles" value={profiles.length} /></Card></Col>
                  <Col xs={24} md={8}><Card className="content-card"><Statistic title="Active" value={activeProfileCount} /></Card></Col>
                  <Col xs={24} md={8}><Card className="content-card"><Statistic title="Shadow" value={shadowProfileCount} /></Card></Col>
                </Row>
                <Card
                  className="content-card"
                  extra={canManage ? <Button type="primary" onClick={openCreateProfile}>New Profile</Button> : null}
                >
                  <Table rowKey="id" columns={profileColumns} dataSource={profiles} loading={loadingProfiles} pagination={{ pageSize: 10 }} />
                </Card>
              </Space>
            ),
          },
          {
            key: "runs",
            label: "Runs",
            children: (
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <Card className="content-card" size="small" style={{ position: "sticky", top: 16, zIndex: 2 }}>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={4}><Statistic title="Total runs" value={runStats.total} /></Col>
                    <Col xs={24} md={4}><Statistic title="Active" value={runStats.active} /></Col>
                    <Col xs={24} md={4}><Statistic title="Failed" value={runStats.failed} /></Col>
                    <Col xs={24} md={4}><Statistic title="Challenge" value={runStats.challenge} /></Col>
                    <Col xs={24} md={4}><Statistic title="Pending LLM" value={runStats.pendingLlm} /></Col>
                    <Col xs={24} md={4}><Statistic title="Seed-first" value={runStats.seedFirst} /></Col>
                  </Row>
                  <Space wrap style={{ display: "flex", marginTop: 16, alignItems: "flex-end" }}>
                    <Input.Search
                      allowClear
                      value={runFilters.search}
                      onChange={(event) => setRunFilters((current) => ({ ...current, search: event.target.value }))}
                      placeholder="Search seed URL or native run ID"
                      style={{ width: 280 }}
                    />
                    <Select allowClear placeholder="Profile" style={{ width: 220 }} value={runFilters.profileId} onChange={(value) => setRunFilters((current) => ({ ...current, profileId: value }))} options={profiles.map((profile) => ({ label: profile.name, value: profile.id }))} />
                    <Select allowClear placeholder="Status" style={{ width: 160 }} value={runFilters.status} onChange={(value) => setRunFilters((current) => ({ ...current, status: value }))} options={["pending", "queued", "running", "completed", "failed", "canceled"].map((value) => ({ label: value, value }))} />
                    <Select allowClear placeholder="Mode" style={{ width: 160 }} value={runFilters.executionMode} onChange={(value) => setRunFilters((current) => ({ ...current, executionMode: value }))} options={["layered", "native", "hybrid"].map((value) => ({ label: value, value }))} />
                    <Select allowClear placeholder="Run role" style={{ width: 160 }} value={runFilters.runRole} onChange={(value) => setRunFilters((current) => ({ ...current, runRole: value }))} options={[{ label: "active", value: "active" }, { label: "shadow", value: "shadow" }]} />
                    <Select allowClear placeholder="Failure kind" style={{ width: 180 }} value={runFilters.failureKind} onChange={(value) => setRunFilters((current) => ({ ...current, failureKind: value }))} options={["challenge_detected", "ssrf_blocked", "no_frontier_candidates", "network_tunnel_error", "llm_judge_parse_failed"].map((value) => ({ label: value, value }))} />
                    <Select allowClear placeholder="Warning flag" style={{ width: 180 }} value={runFilters.warningFlag} onChange={(value) => setRunFilters((current) => ({ ...current, warningFlag: value }))} options={["llm_judge_parse_failed", "llm_judge_circuit_open", "challenge_detected", "ssrf_blocked", "retry_demoted_to_normal"].map((value) => ({ label: value, value }))} />
                    <Select allowClear placeholder="Seed strategy" style={{ width: 180 }} value={runFilters.seedStrategy} onChange={(value) => setRunFilters((current) => ({ ...current, seedStrategy: value }))} options={["auto", "seed_first", "frontier_first", "frontier_only"].map((value) => ({ label: value, value }))} />
                    <Button onClick={() => void loadRuns()}>Refresh</Button>
                    <Button onClick={() => setRunFilters((current) => ({ ...current, search: "", profileId: undefined, status: undefined, executionMode: undefined, runRole: undefined, failureKind: undefined, warningFlag: undefined, seedStrategy: undefined }))}>Reset</Button>
                    {canManage ? <Button type="primary" onClick={() => { runForm.setFieldsValue({ executionMode: "layered", maxDepth: 3, maxPages: 60 }); setRunModalOpen(true); }}>New Run</Button> : null}
                    {canManage && selectedRunIds.length > 0 ? <Button danger onClick={() => void bulkCancelRuns()}>Cancel Selected</Button> : null}
                  </Space>
                </Card>
                <Card className="content-card">
                  <Table rowKey="id" columns={runColumns} dataSource={runs} loading={loadingRuns} pagination={{ pageSize: 10 }} rowSelection={canManage ? { selectedRowKeys: selectedRunIds, onChange: (keys) => setSelectedRunIds(keys.map((key) => String(key))), getCheckboxProps: (record) => ({ disabled: record.status === "completed" || record.status === "canceled" }) } : undefined} />
                </Card>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={profileEditor.editing ? "Edit Site Profile" : "Create Site Profile"}
        open={profileEditor.open}
        onClose={() => setProfileEditor({ open: false, editing: null })}
        width={1120}
        extra={<Space><Button onClick={() => setProfileEditor({ open: false, editing: null })}>Close</Button><Button type="primary" loading={saving} disabled={!canManage} onClick={() => void profileForm.submit()}>Save</Button></Space>}
      >
        <Form layout="vertical" form={profileForm} onFinish={submitProfile}>
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Alert type={profileRawMode ? "warning" : "info"} showIcon message={profileRawMode ? "Raw JSON mode bypasses the structured form." : "Structured controls are the default. Raw JSON remains available for advanced overrides."} />
            {resolvedProfileConfig.error ? <Alert type="error" showIcon message={resolvedProfileConfig.error} /> : null}
            <Tabs items={[
              {
                key: "basic",
                label: "Basic",
                children: (
                  <Row gutter={[16, 16]}>
                    <Col xs={24} lg={16}>
                      <Card size="small" title="Identity">
                        <Row gutter={[16, 16]}>
                          <Col xs={24} md={12}><Form.Item name="name" label="Profile name" rules={[{ required: true }]}><Input disabled={profileRawMode} /></Form.Item></Col>
                          <Col xs={24} md={12}><Form.Item name="matchHost" label="Match host" rules={[{ required: true }]}><Input disabled={profileRawMode} placeholder="*.example.com" /></Form.Item></Col>
                          <Col xs={24}><Form.Item name="description" label="Description"><Input disabled={profileRawMode} /></Form.Item></Col>
                        </Row>
                      </Card>
                    </Col>
                    <Col xs={24} lg={8}>
                      <Card size="small" title="Status">
                        <Form.Item name="executionMode" label="Execution mode"><Select disabled={profileRawMode} options={["layered", "native", "hybrid"].map((value) => ({ label: value, value }))} /></Form.Item>
                        <Form.Item name="isActive" valuePropName="checked" label="Active"><Switch disabled={profileRawMode} /></Form.Item>
                        <Form.Item name={["config", "sourceTier"]} label="Source tier"><Select disabled={profileRawMode} options={["tier1", "tier2", "tier3"].map((value) => ({ label: value, value }))} /></Form.Item>
                      </Card>
                    </Col>
                    <Col xs={24}>
                      <Card size="small" title="Match preview">
                        <Space wrap style={{ display: "flex" }}>
                          <Form.Item name="previewUrl" label="Preview URL" style={{ flex: 1, minWidth: 360, marginBottom: 0 }}><Input placeholder="https://news.example.com/world/latest" /></Form.Item>
                          <Button loading={profilePreviewLoading} onClick={() => void previewProfileMatch()}>Preview match</Button>
                        </Space>
                        {profileMatchPreview ? (
                          <Space direction="vertical" size="middle" style={{ width: "100%", marginTop: 16 }}>
                            <Alert
                              type={profileMatchPreview.draftMatches ? "success" : "warning"}
                              showIcon
                              message={profileMatchPreview.draftMatches ? "Draft profile matches this URL" : "Draft profile does not match this URL"}
                              description={
                                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                                  <Typography.Text>{profileMatchPreview.draftMatchReason}</Typography.Text>
                                  <Space wrap>{summarizeProfileConfig(profileMatchPreview.draft.config).map((entry) => <Tag key={`draft-${entry}`} color="blue">{entry}</Tag>)}</Space>
                                </Space>
                              }
                            />
                            <Alert
                              type={profileMatchPreview.activeMatch ? "info" : "warning"}
                              showIcon
                              message={profileMatchPreview.activeMatch ? `Active profile match: ${profileMatchPreview.activeMatch.name}` : "No active saved profile currently matches this URL"}
                              description={
                                profileMatchPreview.activeMatch ? (
                                  <Space wrap>{summarizeProfileConfig(profileMatchPreview.activeMatch.config).map((entry) => <Tag key={`active-${entry}`}>{entry}</Tag>)}</Space>
                                ) : (
                                  "This preview is based on the draft form values only."
                                )
                              }
                            />
                          </Space>
                        ) : null}
                      </Card>
                    </Col>
                  </Row>
                ),
              },
              {
                key: "strategy",
                label: "Strategy",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title="Seed discovery">
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "strategy"]} label="Strategy"><Select disabled={profileRawMode} options={["auto", "seed_first", "frontier_first", "frontier_only"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "mode"]} label="Discovery mode"><Select disabled={profileRawMode} options={["robots", "common_paths", "sitemap_only", "disabled"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "freshnessWindowHours"]} label="Freshness hours"><InputNumber min={1} max={24 * 365} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "maxSeedUrls"]} label="Max seed URLs"><InputNumber min={1} max={500} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "topologyBudgetPages"]} label="Topology pages"><InputNumber min={1} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "topologyBudgetDepth"]} label="Topology depth"><InputNumber min={1} max={8} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "minCandidates"]} label="Min candidates"><InputNumber min={1} max={200} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "minArticleRatio"]} label="Min article ratio"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "maxNoiseRatio"]} label="Max noise ratio"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "minFreshRatio"]} label="Min fresh ratio"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                      </Row>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={12}>
                        <Card size="small" title="Layered frontier">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "maxDepth"]} label="Max depth"><InputNumber min={1} max={8} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "maxPages"]} label="Max pages"><InputNumber min={1} max={500} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "maxChildrenPerNode"]} label="Max children"><InputNumber min={1} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "scoreThreshold"]} label="Score threshold"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "paginationKeepCount"]} label="Pagination pages"><InputNumber min={1} max={20} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                          </Row>
                        </Card>
                      </Col>
                      <Col xs={24} lg={12}>
                        <Card size="small" title="Native deep crawl">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={8}><Form.Item name={["config", "nativeOptions", "deepCrawlStrategy", "type"]} label="Strategy"><Select disabled={profileRawMode} options={["auto", "BFSDeepCrawlStrategy", "BestFirstCrawlingStrategy"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                            <Col xs={24} md={8}><Form.Item name={["config", "nativeOptions", "fallbackToLayered"]} valuePropName="checked" label="Fallback"><Switch disabled={profileRawMode} /></Form.Item></Col>
                            <Col xs={24} md={4}><Form.Item name={["config", "nativeOptions", "minAcceptedResults"]} label="Min accepted"><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={4}><Form.Item name={["config", "nativeOptions", "minArticleResults"]} label="Min article"><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "nativeOptions", "deepCrawlStrategy", "params", "max_depth"]} label="Native max depth"><InputNumber min={1} max={8} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "nativeOptions", "deepCrawlStrategy", "params", "max_pages"]} label="Native max pages"><InputNumber min={1} max={500} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                          </Row>
                        </Card>
                      </Col>
                    </Row>
                  </Space>
                ),
              },
              {
                key: "llm",
                label: "LLM / Locale / DOM",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title="LLM assist">
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "enabled"]} valuePropName="checked" label="Enabled"><Switch disabled={profileRawMode} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "recallMode"]} label="Recall mode"><Select disabled={profileRawMode} options={["high_recall", "balanced", "low_cost"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "minJudgeConfidence"]} label="Min confidence"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "shadowEvaluationRuns"]} label="Shadow runs"><InputNumber min={1} max={10} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "home"]} label="Home budget"><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "category"]} label="Category budget"><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "list"]} label="List budget"><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "article"]} label="Article budget"><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name={["config", "llmAssist", "autoPublishThresholds", "minArticleLift"]} label="Auto-publish article lift"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name={["config", "llmAssist", "autoPublishThresholds", "minNoiseReduction"]} label="Auto-publish noise reduction"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name={["config", "llmAssist", "autoPublishThresholds", "minJudgeConfidence"]} label="Auto-publish confidence"><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                      </Row>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={12}>
                        <Card size="small" title="Locale & host scope">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={8}><Form.Item name={["config", "hostScope"]} label="Host scope"><Select disabled={profileRawMode} options={["registrable_domain", "strict_hosts"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                            <Col xs={24} md={8}><Form.Item name={["config", "localeScope", "locale"]} label="Preferred locale"><Input disabled={profileRawMode} placeholder="en-GB" /></Form.Item></Col>
                            <Col xs={24} md={8}><Form.Item name={["config", "localeScope", "acceptLanguages"]} label="Accept-Language"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "allowedHosts"]} label="Allowed hosts"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "allowedDomains"]} label="Allowed domains"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "blockedDomains"]} label="Blocked domains"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "localeScope", "denyUrlPatterns"]} label="Locale deny URL patterns"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "localeScope", "denyHostPatterns"]} label="Locale deny host patterns"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                          </Row>
                        </Card>
                      </Col>
                      <Col xs={24} lg={12}>
                        <Card size="small" title="DOM scopes & keywords">
                          <Form.Item name={["config", "domLinkScopes"]} label="Link scopes"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                          <Form.Item name={["config", "domLinkExcludeSelectors"]} label="Exclude selectors"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                          <Form.Item name={["config", "priorityKeywords"]} label="Priority keywords"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                          <Form.Item name={["config", "denyKeywords"]} label="Deny keywords"><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                        </Card>
                      </Col>
                    </Row>
                  </Space>
                ),
              },
              {
                key: "patterns",
                label: "Patterns / JSON",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title="URL patterns">
                      <Row gutter={[16, 16]}>
                        {(["home", "category", "list", "article", "exclude"] as const).map((key) => (
                          <Col xs={24} md={key === "exclude" ? 24 : 12} key={key}>
                            <Form.Item name={["config", "urlPatterns", key]} label={`${key} patterns`}>
                              <Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} />
                            </Form.Item>
                          </Col>
                        ))}
                      </Row>
                    </Card>
                    <Card size="small" title="Page type signals & freshness">
                      <Row gutter={[16, 16]}>
                        {(["home", "category", "list", "article", "deny"] as const).map((key) => (
                          <Col xs={24} lg={12} key={`signal-${key}`}>
                            <Card size="small" type="inner" title={`${key} signals`}>
                              <Form.Item name={["config", "pageTypeSignals", key, "patterns"]} label="Patterns">
                                <Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} />
                              </Form.Item>
                              <Form.Item name={["config", "pageTypeSignals", key, "keywords"]} label="Keywords">
                                <Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} />
                              </Form.Item>
                            </Card>
                          </Col>
                        ))}
                        <Col xs={24}>
                          <Card size="small" type="inner" title="Freshness rules">
                            <Row gutter={[16, 16]}>
                              <Col xs={24} md={8}><Form.Item name={["config", "freshnessRules", "recentHours"]} label="Recent hours"><InputNumber min={1} max={24 * 30} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                              <Col xs={24} md={8}><Form.Item name={["config", "freshnessRules", "weekHours"]} label="Week hours"><InputNumber min={1} max={24 * 90} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                              <Col xs={24} md={8}><Form.Item name={["config", "freshnessRules", "monthHours"]} label="Month hours"><InputNumber min={1} max={24 * 365} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            </Row>
                          </Card>
                        </Col>
                      </Row>
                    </Card>
                    <Card size="small" title="Advanced JSON">
                      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                        <Space wrap>
                          <Typography.Text strong>Raw JSON mode</Typography.Text>
                          <Switch checked={profileRawMode} onChange={(checked) => void handleProfileRawModeChange(checked)} />
                        </Space>
                        <Form.Item name="configJson" label="Config JSON">
                          <Input.TextArea rows={18} spellCheck={false} disabled={!profileRawMode} />
                        </Form.Item>
                        <Collapse items={[{ key: "preview", label: "Resolved config preview", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(resolvedProfileConfig.config ?? {})}</Typography.Paragraph> }]} />
                      </Space>
                    </Card>
                  </Space>
                ),
              },
            ]} />
          </Space>
        </Form>
      </Drawer>

      <Modal open={versionsOpen} title="Profile Versions" onCancel={() => { setVersionsOpen(false); setCurrentVersionProfile(null); }} footer={null} width={920}>
        <Table rowKey="id" dataSource={versions} pagination={false} columns={[
          { title: "Version", dataIndex: "version", key: "version", width: 90 },
          { title: "Mode", dataIndex: "executionMode", key: "executionMode", width: 120 },
          { title: "Created", key: "createdAt", width: 180, render: (_, record) => formatDateTime(record.createdAt) },
          { title: "Summary", key: "summary", render: (_, record) => <Space wrap>{summarizeProfileConfig(asRecord(record.config) ?? {}).map((entry) => <Tag key={`${record.id}-${entry}`}>{entry}</Tag>)}</Space> },
          { title: "Actions", key: "actions", width: 120, render: (_, record) => currentVersionProfile ? <Button size="small" danger onClick={() => void rollbackVersion(currentVersionProfile.id, record.version)}>Rollback</Button> : null },
        ]} />
      </Modal>

      <Modal open={runModalOpen} title="Create Crawl Frontier Run" onCancel={() => setRunModalOpen(false)} onOk={() => void runForm.submit()} okButtonProps={{ loading: saving, disabled: !canManage }}>
        <Form layout="vertical" form={runForm} onFinish={submitRun}>
          <Form.Item name="seedUrl" label="Seed URL" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="profileId" label="Profile" extra="Leave empty to auto-match by host."><Select allowClear options={profiles.map((profile) => ({ label: `${profile.name} (${profile.matchHost})`, value: profile.id }))} /></Form.Item>
          <Form.Item name="executionMode" label="Execution Mode Override"><Select allowClear options={["layered", "native", "hybrid"].map((value) => ({ label: value, value }))} /></Form.Item>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}><Form.Item name="maxDepth" label="Max Depth"><InputNumber min={1} max={8} style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="maxPages" label="Max Pages"><InputNumber min={1} max={500} style={{ width: "100%" }} /></Form.Item></Col>
          </Row>
          <Form.Item name="keywordsText" label="Keywords" extra="Comma or newline separated."><Input.TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>

      <Drawer title="Crawl Frontier Run Detail" open={runDrawerOpen} onClose={() => { setRunDrawerOpen(false); setSelectedRun(null); setSelectedNodeIds([]); }} width={1320}>
        {selectedRun ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card size="small">
              <Space direction="vertical" size="small" style={{ width: "100%" }}>
                <Space wrap size={[4, 4]}>
                  <Tag color={runStatusColors[selectedRun.status]}>{selectedRun.status}</Tag>
                  {selectedRunDiagnostics?.runRole ? <Tag color="blue">{selectedRunDiagnostics.runRole}</Tag> : null}
                  {selectedRunDiagnostics?.failureKind ? <Tag color="red">{selectedRunDiagnostics.failureKind}</Tag> : null}
                  {selectedRunDiagnostics?.seedStrategy ? <Tag color="green">{`seed:${selectedRunDiagnostics.seedStrategy}`}</Tag> : null}
                  {selectedRunDiagnostics?.seedMethod ? <Tag color="lime">{selectedRunDiagnostics.seedMethod}</Tag> : null}
                  {selectedRunDiagnostics?.fallbackStage ? <Tag color="gold">{selectedRunDiagnostics.fallbackStage}</Tag> : null}
                  {selectedRunDiagnostics?.pendingLlmJobs ? <Tag color="magenta">{`pending:${selectedRunDiagnostics.pendingLlmJobs}`}</Tag> : null}
                  {selectedRunDiagnostics?.warningFlags.map((flag) => <Tag key={`run-${flag}`} color="gold">{flag}</Tag>)}
                </Space>
                <Typography.Text>{selectedRun.seedUrl}</Typography.Text>
                <Typography.Text type="secondary">{selectedRun.profile?.name ?? "auto"} / {selectedRun.executionMode}</Typography.Text>
              </Space>
            </Card>

            <Tabs activeKey={runDrawerTab} onChange={setRunDrawerTab} items={[
              {
                key: "overview",
                label: "Overview",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} md={6}><Card size="small"><Statistic title="Pages" value={selectedRun.pageCount} /></Card></Col>
                      <Col xs={24} md={6}><Card size="small"><Statistic title="Nodes" value={selectedRun.nodeCount} /></Card></Col>
                      <Col xs={24} md={6}><Card size="small"><Statistic title="Articles" value={selectedRun.articleCount} /></Card></Col>
                      <Col xs={24} md={6}><Card size="small"><Statistic title="Pending LLM jobs" value={selectedRunSummary?.pendingLlmJudgeJobs ?? 0} /></Card></Col>
                    </Row>
                    <Card size="small" title="Coverage & diagnostics">
                      <Descriptions size="small" column={1} bordered>
                        <Descriptions.Item label="Coverage by type">{formatCountSummary(selectedRunSummary?.coverageByPageType)}</Descriptions.Item>
                        <Descriptions.Item label="Coverage by depth">{formatCountSummary(selectedRunSummary?.coverageByDepth)}</Descriptions.Item>
                        <Descriptions.Item label="Candidate stats">{formatCountSummary(selectedRunSummary?.candidateStats)}</Descriptions.Item>
                        <Descriptions.Item label="Rejection counts">{formatCountSummary(selectedRunSummary?.rejectionCounts)}</Descriptions.Item>
                        <Descriptions.Item label="Judge summary">
                          {formatCountSummary(asRecord(selectedRunSummary?.judgeSummary)?.methods)}
                          {asNumber(asRecord(selectedRunSummary?.judgeSummary)?.averageConfidence) !== null ? ` · avg ${formatNumber(asRecord(selectedRunSummary?.judgeSummary)?.averageConfidence)}` : ""}
                        </Descriptions.Item>
                      </Descriptions>
                    </Card>
                    <Card size="small" title="Root diagnosis">
                      <Collapse items={[
                        { key: "structured", label: "Structured diagnosis", children: <Descriptions size="small" column={2}><Descriptions.Item label="Failure kind">{selectedRunDiagnostics?.failureKind ?? "-"}</Descriptions.Item><Descriptions.Item label="Last error">{selectedRun.lastError ?? "-"}</Descriptions.Item><Descriptions.Item label="Started at">{formatDateTime(selectedRun.startedAt)}</Descriptions.Item><Descriptions.Item label="Finished at">{formatDateTime(selectedRun.finishedAt)}</Descriptions.Item></Descriptions> },
                        { key: "json", label: "Root diagnosis JSON", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(selectedRunSummary?.rootDiagnosis ?? asRecord(selectedRun.metadata)?.rootDiagnosis)}</Typography.Paragraph> },
                      ]} />
                    </Card>
                  </Space>
                ),
              },
              {
                key: "strategy",
                label: "Strategy Trace",
                children: (
                  <Card size="small">
                    <Steps
                      direction="vertical"
                      current={-1}
                      items={(selectedRunSummary?.trace ?? []).map((step) => ({
                        title: step.label,
                        description: <Space direction="vertical" size={4}><Typography.Text>{step.detail ?? "-"}</Typography.Text><Space wrap><Tag color={step.status === "failed" ? "red" : step.status === "warning" ? "gold" : step.status === "active" ? "blue" : step.status === "completed" ? "green" : "default"}>{step.status}</Tag>{(step.tags ?? []).map((entry) => <Tag key={`${step.key}-${entry}`}>{entry}</Tag>)}</Space></Space>,
                        status: step.status === "failed" ? "error" : step.status === "active" ? "process" : step.status === "completed" ? "finish" : "wait",
                      }))}
                    />
                  </Card>
                ),
              },
              {
                key: "nodes",
                label: "Nodes",
                children: (
                  <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                    <Card size="small">
                      <Space wrap style={{ display: "flex", alignItems: "flex-end" }}>
                        <Input allowClear value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} placeholder="Search URL or path" style={{ width: 260 }} />
                        <Select value={nodeStatusFilter} onChange={setNodeStatusFilter} style={{ width: 160 }} options={[{ label: "All statuses", value: "all" }, ...(["pending", "queued", "running", "completed", "failed", "skipped", "canceled"] as const).map((value) => ({ label: value, value }))]} />
                        <Select value={nodePageTypeFilter} onChange={setNodePageTypeFilter} style={{ width: 160 }} options={[{ label: "All page types", value: "all" }, ...uniqueStringList((selectedRun.nodes ?? []).map((node) => node.pageType)).map((value) => ({ label: value, value }))]} />
                        <Tooltip title="Only show nodes with warnings, rejections, or failures."><Space><Switch checked={nodeProblemsOnly} onChange={setNodeProblemsOnly} /><Typography.Text>Problems only</Typography.Text></Space></Tooltip>
                        {selectedNodeIds.length > 0 ? <Button onClick={() => void bulkRetryNodes()}>Retry selected</Button> : null}
                      </Space>
                    </Card>
                    <Table<NodeTreeRow> rowKey="id" columns={nodeColumns} dataSource={selectedNodesTree} pagination={{ pageSize: 20 }} rowSelection={canManage ? { selectedRowKeys: selectedNodeIds, onChange: (keys) => setSelectedNodeIds(keys.map((key) => String(key))), getCheckboxProps: (record) => ({ disabled: record.status !== "failed" && record.status !== "skipped" }) } : undefined} />
                  </Space>
                ),
              },
              {
                key: "llm",
                label: "LLM & Shadow",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title="LLM lifecycle">
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label="Run role">{selectedRunDiagnostics?.runRole ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Pending judge jobs">{selectedRunSummary?.pendingLlmJudgeJobs ?? 0}</Descriptions.Item>
                        <Descriptions.Item label="Judge count">{formatNumber(asRecord(selectedRunSummary?.judgeSummary)?.count, 0)}</Descriptions.Item>
                        <Descriptions.Item label="Avg confidence">{formatNumber(asRecord(selectedRunSummary?.judgeSummary)?.averageConfidence)}</Descriptions.Item>
                      </Descriptions>
                      <Space wrap size={[4, 4]} style={{ marginTop: 12 }}>{(selectedRunSummary?.warningFlags ?? []).filter((flag) => flag.startsWith("llm_")).map((flag) => <Tag key={flag} color="gold">{flag}</Tag>)}</Space>
                      <Space style={{ marginTop: 12 }}><Button href={buildLlmLogsHref({ feature: "crawl_frontier_judge", runId: selectedRun.id, ...(selectedRun.profile?.id ? { profileId: selectedRun.profile.id } : {}) })}>View judge logs</Button><Button href={buildLlmLogsHref({ feature: "crawl_frontier_learn", runId: selectedRun.id, ...(selectedRun.profile?.id ? { profileId: selectedRun.profile.id } : {}) })}>View learn logs</Button></Space>
                    </Card>
                    <Card size="small" title="Shadow profile">
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label="Shadow profile">{asString(asRecord(selectedRunSummary?.shadowSummary)?.profileId) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Published profile">{asString(asRecord(selectedRunSummary?.shadowSummary)?.publishedProfileId) ?? "-"}</Descriptions.Item>
                      </Descriptions>
                      <Collapse style={{ marginTop: 12 }} items={[{ key: "shadowComparison", label: "Shadow comparison", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(asRecord(selectedRunSummary?.shadowSummary)?.comparison)}</Typography.Paragraph> }]} />
                    </Card>
                  </Space>
                ),
              },
              {
                key: "diagnostics",
                label: "Seed & Diagnostics",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title="Seed summary">
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label="Strategy">{asString(asRecord(selectedRunSummary?.seedSummary)?.strategy) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Method">{asString(asRecord(selectedRunSummary?.seedSummary)?.method) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Origin">{asString(asRecord(selectedRunSummary?.seedSummary)?.origin) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Fallback">{asString(asRecord(selectedRunSummary?.seedSummary)?.fallbackStage) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Seed yield">{formatCountSummary(asRecord(asRecord(selectedRunSummary?.seedSummary)?.yield))}</Descriptions.Item>
                        <Descriptions.Item label="Seed quality">{stringifyJson(asRecord(asRecord(selectedRunSummary?.seedSummary)?.quality))}</Descriptions.Item>
                      </Descriptions>
                    </Card>
                    <Card size="small" title="Diagnostics payloads">
                      <Collapse items={[
                        { key: "seedDiagnostics", label: "Seed diagnostics", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(asRecord(asRecord(selectedRunSummary?.seedSummary)?.diagnostics))}</Typography.Paragraph> },
                        { key: "runMetadata", label: "Run metadata", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(selectedRun.metadata)}</Typography.Paragraph> },
                      ]} />
                    </Card>
                  </Space>
                ),
              },
              {
                key: "repair",
                label: "Repair & Extraction",
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title="Article repair">
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}><Statistic title="Article-linked nodes" value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.available) ?? 0} /></Col>
                        <Col xs={24} md={6}><Statistic title="Repair attempted" value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.attempted) ?? 0} /></Col>
                        <Col xs={24} md={6}><Statistic title="Repair applied" value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.applied) ?? 0} /></Col>
                        <Col xs={24} md={6}><Statistic title="Repair failed" value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.failed) ?? 0} /></Col>
                      </Row>
                      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>Use node inspection to see which fields were repaired, what extraction artifacts were available, and why repair was skipped or failed.</Typography.Paragraph>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={8}>
                        <Card size="small" title="Repaired fields">
                          <Space wrap>{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.repairedFields) ?? {}).map(([field, count]) => <Tag key={`repair-field-${field}`} color="green">{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.repairedFields) ?? {}).length === 0 ? <Typography.Text type="secondary">No repaired fields recorded.</Typography.Text> : null}</Space>
                        </Card>
                      </Col>
                      <Col xs={24} lg={8}>
                        <Card size="small" title="Missing fields">
                          <Space wrap>{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.missingFields) ?? {}).map(([field, count]) => <Tag key={`missing-field-${field}`} color="orange">{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.missingFields) ?? {}).length === 0 ? <Typography.Text type="secondary">No missing field diagnostics recorded.</Typography.Text> : null}</Space>
                        </Card>
                      </Col>
                      <Col xs={24} lg={8}>
                        <Card size="small" title="Repair errors & models">
                          <Space wrap>{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.errors) ?? {}).map(([field, count]) => <Tag key={`repair-error-${field}`} color="red">{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.models) ?? {}).map(([field, count]) => <Tag key={`repair-model-${field}`} color="blue">{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.errors) ?? {}).length === 0 && Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.models) ?? {}).length === 0 ? <Typography.Text type="secondary">No model/error diagnostics recorded.</Typography.Text> : null}</Space>
                        </Card>
                      </Col>
                    </Row>
                  </Space>
                ),
              },
            ]} />
          </Space>
        ) : null}
      </Drawer>

      <Drawer title="Node Diagnostics" open={nodeDrawerOpen} onClose={() => { setNodeDrawerOpen(false); setSelectedNode(null); }} width={980}>
        {loadingNodeDetail ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "4rem 0" }}><Spin /></div>
        ) : selectedNode ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card size="small">
              <Space direction="vertical" size="small" style={{ width: "100%" }}>
                <Space wrap size={[4, 4]}>
                  <Tag>{selectedNode.pageType}</Tag>
                  <Tag>{selectedNode.queueClass}</Tag>
                  <Tag color={nodeStatusColors[selectedNode.status]}>{selectedNode.status}</Tag>
                  {asString(asRecord(selectedNode.metadata)?.failureKind) ? <Tag color="red">{String(asRecord(selectedNode.metadata)?.failureKind)}</Tag> : null}
                  {asStringArray(asRecord(selectedNode.metadata)?.warningFlags).map((flag) => <Tag key={`node-${flag}`} color="gold">{flag}</Tag>)}
                </Space>
                <Typography.Text>{selectedNode.url}</Typography.Text>
                <Typography.Text type="secondary">discovery: {formatPath(selectedNode.metadata?.discoveryPath)} · frontier: {formatPath(selectedNode.metadata?.frontierPath)}</Typography.Text>
              </Space>
            </Card>
            <Card size="small" title="Node basics">
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="Canonical URL">{selectedNode.canonicalUrl ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Depth">{selectedNode.depth}</Descriptions.Item>
                <Descriptions.Item label="Attempts">{selectedNode.attempts}</Descriptions.Item>
                <Descriptions.Item label="Parent node">{selectedNode.parentNodeId ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Discovered at">{formatDateTime(selectedNode.discoveredAt)}</Descriptions.Item>
                <Descriptions.Item label="Crawled at">{formatDateTime(selectedNode.crawledAt)}</Descriptions.Item>
                <Descriptions.Item label="Cluster label">{asString(asRecord(selectedNode.metadata)?.clusterLabel) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Seed origin">{asString(asRecord(selectedNode.metadata)?.seedOrigin) ?? "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title="Node judgment">
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="Score">{formatNumber(selectedNode.score)}</Descriptions.Item>
                <Descriptions.Item label="Freshness">{formatNumber(selectedNode.freshnessScore)}</Descriptions.Item>
                <Descriptions.Item label="Judge method">{asString(asRecord(selectedNode.metadata)?.judgeMethod) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Judge confidence">{formatNumber(asRecord(selectedNode.metadata)?.judgeConfidence)}</Descriptions.Item>
                <Descriptions.Item label="Judge reason">{asString(asRecord(selectedNode.metadata)?.judgeReason) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Locale hint">{asString(asRecord(selectedNode.metadata)?.localeHint) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Selector hints" span={2}><Space wrap>{asStringArray(asRecord(selectedNode.metadata)?.selectorHints).map((hint) => <Tag key={hint} color="purple">{hint}</Tag>)}{asStringArray(asRecord(selectedNode.metadata)?.selectorHints).length === 0 ? "-" : null}</Space></Descriptions.Item>
                <Descriptions.Item label="Rejection reason">{selectedNode.rejectionReason ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Last error">{selectedNode.lastError ?? "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title="Run linkage">
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="Run">{selectedNode.run.id}</Descriptions.Item>
                <Descriptions.Item label="Seed URL">{selectedNode.run.seedUrl}</Descriptions.Item>
                <Descriptions.Item label="Run status">{selectedNode.run.status}</Descriptions.Item>
                <Descriptions.Item label="Execution mode">{selectedNode.run.executionMode}</Descriptions.Item>
                <Descriptions.Item label="Profile">{selectedNode.run.profile?.name ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Profile host">{selectedNode.run.profile?.matchHost ?? "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title="Crawl result">
              {selectedNode.crawlResult ? <Descriptions size="small" column={2} bordered><Descriptions.Item label="Crawl result ID">{selectedNode.crawlResult.id}</Descriptions.Item><Descriptions.Item label="Fetched at">{formatDateTime(selectedNode.crawlResult.fetchedAt)}</Descriptions.Item><Descriptions.Item label="Source URL">{selectedNode.crawlResult.sourceUrl}</Descriptions.Item><Descriptions.Item label="Markdown ref">{selectedNode.crawlResult.markdownRef}</Descriptions.Item></Descriptions> : <Empty description="No crawl result linked to this node yet." />}
            </Card>
            <Card size="small" title="Article & extraction">
              {selectedNode.article || selectedNode.processedArticle ? (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  {selectedNode.article ? <Descriptions size="small" column={2} bordered><Descriptions.Item label="Article URL">{selectedNode.article.url}</Descriptions.Item><Descriptions.Item label="Crawl at">{formatDateTime(selectedNode.article.crawlAt)}</Descriptions.Item><Descriptions.Item label="Title guess">{selectedNode.article.titleGuess ?? "-"}</Descriptions.Item><Descriptions.Item label="Source label">{selectedNode.article.sourceLabel ?? "-"}</Descriptions.Item><Descriptions.Item label="Language">{selectedNode.article.language ?? "-"}</Descriptions.Item><Descriptions.Item label="Repair applied">{asRecord(selectedNode.article.llmRepair)?.applied === true ? "yes" : "no"}</Descriptions.Item></Descriptions> : null}
                  {selectedNode.processedArticle ? <Descriptions size="small" column={2} bordered><Descriptions.Item label="Processed title">{selectedNode.processedArticle.title ?? "-"}</Descriptions.Item><Descriptions.Item label="Published at">{formatDateTime(selectedNode.processedArticle.publishedAt)}</Descriptions.Item><Descriptions.Item label="Author">{selectedNode.processedArticle.author ?? "-"}</Descriptions.Item><Descriptions.Item label="Category">{selectedNode.processedArticle.category ?? "-"}</Descriptions.Item><Descriptions.Item label="Quality score">{formatNumber(selectedNode.processedArticle.qualityScore)}</Descriptions.Item><Descriptions.Item label="LLM model">{selectedNode.processedArticle.llmModel ?? "-"}</Descriptions.Item></Descriptions> : null}
                  {selectedNode.extractionSummary ? (
                    <Card size="small" type="inner" title="Extraction summary">
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label="Processed status">{selectedNode.extractionSummary.processedStatus ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Quality score">{formatNumber(selectedNode.extractionSummary.qualityScore)}</Descriptions.Item>
                        <Descriptions.Item label="Extracted fields" span={2}><Space wrap>{selectedNode.extractionSummary.extractedFields.map((field) => <Tag key={`extracted-${field}`} color="green">{field}</Tag>)}{selectedNode.extractionSummary.extractedFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label="Missing fields" span={2}><Space wrap>{selectedNode.extractionSummary.missingFields.map((field) => <Tag key={`missing-${field}`} color="orange">{field}</Tag>)}{selectedNode.extractionSummary.missingFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label="Removed noise" span={2}><Space wrap>{(selectedNode.extractionSummary.removedNoiseTypes ?? []).map((field) => <Tag key={`noise-${field}`} color="purple">{field}</Tag>)}{(selectedNode.extractionSummary.removedNoiseTypes ?? []).length === 0 ? "-" : null}</Space></Descriptions.Item>
                      </Descriptions>
                    </Card>
                  ) : null}
                  {selectedNode.repairSummary ? (
                    <Card size="small" type="inner" title="Repair summary">
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label="Attempted">{selectedNode.repairSummary.attempted ? "yes" : "no"}</Descriptions.Item>
                        <Descriptions.Item label="Applied">{selectedNode.repairSummary.applied ? "yes" : "no"}</Descriptions.Item>
                        <Descriptions.Item label="Model">{selectedNode.repairSummary.model ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label="Latency">{formatNumber(selectedNode.repairSummary.latencyMs, 0)}</Descriptions.Item>
                        <Descriptions.Item label="Missing fields" span={2}><Space wrap>{selectedNode.repairSummary.missingFields.map((field) => <Tag key={`repair-missing-${field}`} color="orange">{field}</Tag>)}{selectedNode.repairSummary.missingFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label="Repaired fields" span={2}><Space wrap>{selectedNode.repairSummary.repairedFields.map((field) => <Tag key={`repair-applied-${field}`} color="green">{field}</Tag>)}{selectedNode.repairSummary.repairedFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label="Error" span={2}>{selectedNode.repairSummary.error ?? "-"}</Descriptions.Item>
                      </Descriptions>
                    </Card>
                  ) : null}
                  {selectedNode.article?.llmRepair ? <Collapse items={[{ key: "repair", label: "Repair diagnostics JSON", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(selectedNode.article.llmRepair)}</Typography.Paragraph> }]} /> : null}
                </Space>
              ) : <Empty description="No article or processed article linked to this node." />}
            </Card>
            <Card size="small" title="Related LLM logs">
              <Space wrap>
                {selectedNode.llmLogFilters?.judge ? <Button href={buildLlmLogsHref(selectedNode.llmLogFilters.judge)}>Judge logs</Button> : null}
                {selectedNode.llmLogFilters?.learn ? <Button href={buildLlmLogsHref(selectedNode.llmLogFilters.learn)}>Learn logs</Button> : null}
                {selectedNode.llmLogFilters?.repair ? <Button href={buildLlmLogsHref(selectedNode.llmLogFilters.repair)}>Repair logs</Button> : null}
              </Space>
            </Card>
            <Card size="small" title="Metadata">
              <Collapse items={[
                { key: "nodeMetadata", label: "Node metadata JSON", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(selectedNode.metadata)}</Typography.Paragraph> },
                { key: "articleMetadata", label: "Article metadata JSON", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(selectedNode.article?.metadata)}</Typography.Paragraph> },
                { key: "crawlResultMetadata", label: "Crawl result metadata JSON", children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{stringifyJson(selectedNode.crawlResult?.metadata)}</Typography.Paragraph> },
              ]} />
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
