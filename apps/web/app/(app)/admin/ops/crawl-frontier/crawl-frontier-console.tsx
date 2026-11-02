"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
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

import { ChartEmptyState } from "@/components/chart-empty-state";
import { FilterBar } from "@/components/filter-bar";
import { KpiStrip } from "@/components/kpi-strip";
import { PageHeader } from "@/components/page-header";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import {
  findUnsupportedFrontierProfileIssues,
  getCrawlConfigPolicyIssueTranslationKey,
  type CrawlConfigPolicyIssue,
} from "@/lib/crawl-config-policy";

import { canViewCrawlFrontierLlmLogs } from "./crawl-frontier-access";
import { buildSitemapDiagnosticRows } from "./crawl-frontier-diagnostics";
import { CrawlWorkflowStudio } from "./crawl-workflow-studio";
import {
  buildWorkflowCandidateTraceChain,
  buildWorkflowCandidateTraceSummary,
  buildWorkflowTraceEntryDiffRows,
  formatWorkflowStepSummary,
  type WorkflowCandidateRecord,
  type WorkflowRunEvent,
  type WorkflowRunStep,
} from "./crawl-workflow-view-model";

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
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowBindingMode?: "published" | "pinned";
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
  workflowRunId?: string | null;
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
    trace?: {
      key: string;
      label: string;
      status: "completed" | "active" | "warning" | "failed" | "skipped";
      detail?: string | null;
      tags?: string[];
    }[];
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

interface WorkflowRunDetail {
  id: string;
  workflowOrigin: "bound" | "legacy_bridge";
  workflow?: {
    id: string;
    name: string;
  } | null;
  workflowVersion?: {
    id: string;
    version: number;
    name: string;
  } | null;
  frontierRunId?: string | null;
  status: string;
  runKind: string;
  input?: AnyRecord | null;
  output?: AnyRecord | null;
  graphSnapshot?: AnyRecord | null;
  stepResults: WorkflowRunStep[];
  candidates: WorkflowCandidateRecord[];
  parameterSources: {
    key: string;
    source: string;
    value: unknown;
  }[];
  systemEvents: WorkflowRunEvent[];
  stepCount: number;
  candidateCount: number;
  selectedCount: number;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
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
  workflowId?: string;
  workflowVersionId?: string;
  workflowBindingMode?: "published" | "pinned";
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

interface BulkCancelRunsResponse {
  canceledIds: string[];
  canceledCount: number;
}

interface BulkRetryNodesResponse {
  retriedIds: string[];
  retriedCount: number;
  runIds: string[];
  skippedIds?: string[];
  skippedCount?: number;
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

const runStatusColors: Record<CrawlFrontierRunStatus, string | undefined> = {
  pending: undefined,
  queued: "processing",
  running: "processing",
  completed: "success",
  failed: "error",
  canceled: undefined,
};

const nodeStatusColors: Record<CrawlFrontierNodeStatus, string | undefined> = {
  pending: undefined,
  queued: "processing",
  running: "processing",
  completed: "success",
  failed: "error",
  skipped: "warning",
  canceled: undefined,
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

function formatPolicyIssues(
  issues: CrawlConfigPolicyIssue[],
  t: ReturnType<typeof useTranslation>["t"],
) {
  return issues
    .map(
      (issue) =>
        `${issue.path}: ${t(getCrawlConfigPolicyIssueTranslationKey(issue.code), {
          defaultValue: issue.code,
        })}`,
    )
    .join(", ");
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

function workflowEventColor(level: WorkflowRunEvent["level"]) {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  return undefined;
}

function workflowStepColor(status: WorkflowRunStep["status"]) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "processing";
  if (status === "queued") return "processing";
  if (status === "pending") return undefined;
  return undefined;
}

function uniqueStringList(...lists: (string[] | undefined)[]) {
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
  const tags: { color?: string; label: string }[] = [
    { color: profile.isActive ? "success" : undefined, label: profile.isActive ? "active" : "inactive" },
  ];
  if (typeof shadow?.role === "string") {
    tags.push({ color: undefined, label: shadow.role });
  }
  if (typeof shadow?.state === "string") {
    tags.push({ color: shadow.state === "published" ? "success" : "warning", label: shadow.state });
  }
  if (asRecord(profile.config.llmAssist)?.enabled === true) {
    tags.push({ color: undefined, label: "auto-learn" });
  }
  if (isRecord(asRecord(asRecord(profile.config.llmAssist)?.autoPublishThresholds))) {
    tags.push({ color: undefined, label: "auto-publish" });
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
  const canViewLogLinks = canViewCrawlFrontierLlmLogs(permissions);
  const [messageApi, contextHolder] = message.useMessage();
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingNodeDetail, setLoadingNodeDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<CrawlSiteProfileRecord[]>([]);
  const [workflowOptions, setWorkflowOptions] = useState<{ label: string; value: string }[]>([]);
  const [runs, setRuns] = useState<CrawlFrontierRunRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<CrawlFrontierRunDetail | null>(null);
  const [selectedWorkflowRun, setSelectedWorkflowRun] = useState<WorkflowRunDetail | null>(null);
  const [selectedWorkflowCandidate, setSelectedWorkflowCandidate] =
    useState<WorkflowCandidateRecord | null>(null);
  const [loadingWorkflowRun, setLoadingWorkflowRun] = useState(false);
  const [replayingWorkflowRun, setReplayingWorkflowRun] = useState(false);
  const [selectedNode, setSelectedNode] = useState<CrawlFrontierNodeDetail | null>(null);
  const [activeConsoleTab, setActiveConsoleTab] = useState("profiles");
  const [workflowStudioSelection, setWorkflowStudioSelection] = useState<string | null>(
    null,
  );
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
    const buildResolvedConfig = (config: AnyRecord) => {
      const merged = mergeProfileConfigDefaults(config);
      const issues = findUnsupportedFrontierProfileIssues(merged, "config");
      return {
        config: issues.length > 0 ? null : merged,
        error:
          issues.length > 0
            ? formatPolicyIssues(issues, t)
            : null,
      };
    };
    if (!profileRawMode) {
      return buildResolvedConfig(asRecord(watchedProfileConfig) ?? {});
    }
    try {
      return buildResolvedConfig(
        parseJsonObject(String(watchedProfileConfigJson ?? "{}"), "config"),
      );
    } catch (error) {
      return {
        config: null,
        error: error instanceof Error ? error.message : "Invalid config JSON",
      };
    }
  }, [profileRawMode, t, watchedProfileConfig, watchedProfileConfigJson]);

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
          t("crawlFrontier.errors.loadProfiles"),
        ),
      );
    } finally {
      setLoadingProfiles(false);
    }
  }, [apiClient, canView, messageApi, t]);

  const loadWorkflowOptions = useCallback(async () => {
    if (!canView) return;
    try {
      const response = await apiClient.get<{ id: string; name: string }[]>(
        "admin/crawl-frontier/workflows",
      );
      setWorkflowOptions(
        (response.data ?? []).map((workflow) => ({
          label: workflow.name,
          value: workflow.id,
        })),
      );
    } catch (error) {
      captureClientError("Failed to load crawl strategy workflows", error);
    }
  }, [apiClient, canView]);

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
          t("crawlFrontier.errors.loadRuns"),
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
    void loadWorkflowOptions();
  }, [canView, loadWorkflowOptions]);

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
        workflowId: profile?.workflowId ?? undefined,
        workflowVersionId: profile?.workflowVersionId ?? undefined,
        workflowBindingMode: profile?.workflowBindingMode ?? "published",
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
          t("crawlFrontier.errors.loadProfile"),
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
        workflowId: profileForm.getFieldValue("workflowId") ?? undefined,
        workflowVersionId: profileForm.getFieldValue("workflowVersionId") ?? undefined,
        workflowBindingMode: profileForm.getFieldValue("workflowBindingMode") ?? "published",
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
      const config = profileRawMode
        ? parseJsonObject(values.configJson, "config")
        : mergeProfileConfigDefaults(asRecord(values.config));
      const configIssues = findUnsupportedFrontierProfileIssues(config, "config");
      if (configIssues.length > 0) {
        throw new Error(formatPolicyIssues(configIssues, t));
      }
      const payload = {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        matchHost: values.matchHost.trim(),
        isActive: values.isActive,
        executionMode: values.executionMode,
        workflowId: values.workflowId?.trim() ? values.workflowId.trim() : null,
        workflowVersionId: values.workflowVersionId?.trim()
          ? values.workflowVersionId.trim()
          : null,
        workflowBindingMode: values.workflowBindingMode ?? "published",
        config,
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
    setLoadingWorkflowRun(true);
    try {
      const [runResponse, workflowResponse] = await Promise.all([
        apiClient.get<CrawlFrontierRunDetail>(`admin/crawl-frontier/runs/${runId}`),
        apiClient
          .get<WorkflowRunDetail>(`admin/crawl-frontier/runs/${runId}/workflow-run`)
          .catch(() => null),
      ]);
      setSelectedRun(runResponse.data);
      setSelectedWorkflowRun(workflowResponse?.data ?? null);
      setRunDrawerOpen(true);
      setRunDrawerTab("overview");
      setSelectedNodeIds([]);
      setSelectedWorkflowCandidate(null);
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to load crawl frontier run."));
    } finally {
      setLoadingWorkflowRun(false);
      setSaving(false);
    }
  };

  const reloadSelectedRun = async () => {
    if (!selectedRun) return;
    await openRun(selectedRun.id);
  };

  const replayWorkflowRun = async (workflowRunId: string) => {
    setReplayingWorkflowRun(true);
    try {
      const response = await apiClient.post<{ runId: string; workflow?: { name: string; version: number } }>(
        `admin/crawl-frontier/workflow-runs/${workflowRunId}/replay`,
        {},
      );
      messageApi.success(
        response.data?.workflow
          ? `Replayed ${response.data.workflow.name} v${response.data.workflow.version}.`
          : "Workflow replay started.",
      );
    } catch (error) {
      messageApi.error(extractErrorMessage(error, "Failed to replay workflow run."));
    } finally {
      setReplayingWorkflowRun(false);
    }
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
          const response = await apiClient.post<BulkCancelRunsResponse>(
            "admin/crawl-frontier/runs/cancel",
            { ids },
          );
          const canceledCount =
            typeof response.data.canceledCount === "number"
              ? response.data.canceledCount
              : response.data.canceledIds.length;
          const skippedCount = Math.max(0, ids.length - canceledCount);
          if (canceledCount === 0) {
            messageApi.warning("No crawl frontier runs were canceled.");
          } else if (skippedCount > 0) {
            messageApi.warning(`${canceledCount} runs canceled, ${skippedCount} skipped.`);
          } else {
            messageApi.success(`${canceledCount} runs canceled.`);
          }
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
      title: t("crawlFrontier.console.runDrawer.nodes.retryConfirmTitle"),
      content: t("crawlFrontier.console.runDrawer.nodes.retryConfirmContent"),
      okText: t("crawlFrontier.console.runDrawer.nodes.retrySelected"),
      onOk: async () => {
        setSaving(true);
        try {
          const response = await apiClient.post<BulkRetryNodesResponse>(
            "admin/crawl-frontier/nodes/retry",
            { ids },
          );
          const retriedCount =
            typeof response.data.retriedCount === "number"
              ? response.data.retriedCount
              : response.data.retriedIds.length;
          const skippedCount = response.data.skippedCount ?? response.data.skippedIds?.length ?? 0;
          if (retriedCount > 0 && skippedCount > 0) {
            messageApi.warning(
              `${retriedCount} nodes re-queued, ${skippedCount} skipped because their runs are missing crawlTaskId.`,
            );
          } else if (retriedCount > 0) {
            messageApi.success(`${retriedCount} nodes re-queued.`);
          } else if (skippedCount > 0) {
            messageApi.warning(
              `No nodes were re-queued. ${skippedCount} selected nodes belong to runs missing crawlTaskId.`,
            );
          } else {
            messageApi.warning("No crawl frontier nodes were re-queued.");
          }
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
  const selectedRunRootDiagnosis = asRecord(
    selectedRunSummary?.rootDiagnosis ?? asRecord(selectedRun?.metadata)?.rootDiagnosis,
  );
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
            {diagnostics.failureKind ? <Tag color="error">{diagnostics.failureKind}</Tag> : null}
            {diagnostics.runRole ? <Tag>{diagnostics.runRole}</Tag> : null}
            {record.workflowRunId ? <Tag>workflow</Tag> : null}
            {diagnostics.seedStrategy ? <Tag>{`seed:${diagnostics.seedStrategy}`}</Tag> : null}
            {diagnostics.seedMethod ? <Tag>{diagnostics.seedMethod}</Tag> : null}
            {diagnostics.fallbackStage ? <Tag>{diagnostics.fallbackStage}</Tag> : null}
            {diagnostics.pendingLlmJobs > 0 ? <span className="font-mono text-xs text-muted-foreground">{`pending ${diagnostics.pendingLlmJobs}`}</span> : null}
            {diagnostics.shadowProfileId ? <Tag>shadow-profile</Tag> : null}
            {diagnostics.judgeCount > 0 ? <span className="font-mono text-xs text-muted-foreground">{`judge ${diagnostics.judgeCount}`}</span> : null}
            {diagnostics.warningFlags.slice(0, 4).map((flag) => (
              <Tag key={`${record.id}-${flag}`} color="warning">{flag}</Tag>
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
            {asString(metadata?.judgeMethod) ? <Tag>{String(metadata?.judgeMethod)}</Tag> : null}
            {asNumber(metadata?.judgeConfidence) !== null ? <span className="font-mono text-xs text-muted-foreground">{`conf ${formatNumber(metadata?.judgeConfidence)}`}</span> : null}
            {asStringArray(metadata?.selectorHints).slice(0, 2).map((hint) => (
              <Tag key={`${record.id}-${hint}`}>{hint}</Tag>
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
            {asString(metadata?.failureKind) ? <Tag color="error">{String(metadata?.failureKind)}</Tag> : null}
            {record.rejectionReason ? <Tag>{record.rejectionReason}</Tag> : null}
            {asStringArray(metadata?.warningFlags).slice(0, 3).map((flag) => (
              <Tag key={`${record.id}-${flag}`} color="warning">{flag}</Tag>
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

  const workflowCandidateColumns: ColumnsType<WorkflowCandidateRecord> = useMemo(
    () => [
      {
        title: "Candidate",
        key: "url",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong ellipsis={{ tooltip: record.url }}>
              {record.title || record.url}
            </Typography.Text>
            <Typography.Text type="secondary" ellipsis={{ tooltip: record.url }}>
              {record.url}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "Status",
        key: "status",
        width: 120,
        render: (_, record) => (
          <Tag
            color={
              record.status === "selected"
                ? "success"
                : record.status === "rejected"
                  ? "error"
                  : undefined
            }
          >
            {record.status}
          </Tag>
        ),
      },
      {
        title: "Signals",
        key: "signals",
        width: 260,
        render: (_, record) => {
          const traceSummary = buildWorkflowCandidateTraceSummary(record);
          return (
            <Space wrap size={[4, 4]}>
              {record.pageType ? <Tag>{record.pageType}</Tag> : null}
              {typeof record.score === "number" ? (
                <span className="font-mono text-xs text-muted-foreground">{`score ${record.score.toFixed(2)}`}</span>
              ) : null}
              {typeof record.freshnessScore === "number" ? (
                <span className="font-mono text-xs text-muted-foreground">{`fresh ${record.freshnessScore.toFixed(2)}`}</span>
              ) : null}
              {traceSummary.ruleHits.slice(0, 2).map((rule) => (
                <Tag key={`${record.id}-${rule}`}>
                  {rule}
                </Tag>
              ))}
            </Space>
          );
        },
      },
      {
        title: "Reason",
        dataIndex: "rejectedReason",
        key: "rejectedReason",
        width: 180,
        render: (value: string | null | undefined) => value ?? "-",
      },
      {
        title: "Actions",
        key: "actions",
        width: 120,
        render: (_, record) => (
          <Button size="small" onClick={() => setSelectedWorkflowCandidate(record)}>
            Explain
          </Button>
        ),
      },
    ],
    [],
  );

  if (status === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader kicker={t("nav.groups.admin")} title={t("crawlFrontier.title")} />
        <Alert type="warning" showIcon message={t("settings.adminOnly.title")} description={t("settings.adminOnly.description")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <PageHeader
        kicker={t("nav.groups.admin")}
        title={t("crawlFrontier.title")}
        description={t("crawlFrontier.subtitle")}
      />

      <Tabs
        activeKey={activeConsoleTab}
        onChange={setActiveConsoleTab}
        items={[
          {
            key: "profiles",
            label: t("crawlFrontier.console.tabs.profiles"),
            children: (
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <Card className="content-card">
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <Statistic title={t("crawlFrontier.console.stats.profiles")} value={profiles.length} />
                    <div className="md:border-l md:border-[var(--border)] md:pl-4">
                      <Statistic title={t("crawlFrontier.console.stats.active")} value={activeProfileCount} />
                    </div>
                    <div className="md:border-l md:border-[var(--border)] md:pl-4">
                      <Statistic title={t("crawlFrontier.console.stats.shadow")} value={shadowProfileCount} />
                    </div>
                  </div>
                </Card>
                <Card
                  className="content-card"
                  extra={canManage ? <Button type="primary" onClick={openCreateProfile}>{t("crawlFrontier.console.actions.newProfile")}</Button> : null}
                >
                  <Table rowKey="id" columns={profileColumns} dataSource={profiles} loading={loadingProfiles} pagination={{ pageSize: 10 }} scroll={{ x: "max-content" }} />
                </Card>
              </Space>
            ),
          },
          {
            key: "workflow",
            label: t("crawlFrontier.console.tabs.workflow"),
            children: (
              <CrawlWorkflowStudio
                canManage={canManage}
                selectedWorkflowIdHint={workflowStudioSelection}
              />
            ),
          },
          {
            key: "runs",
            label: t("crawlFrontier.console.tabs.runs"),
            children: (
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <Card className="content-card md:sticky md:top-0 md:z-[2]" size="small">
                  <KpiStrip
                    bare
                    items={[
                      {
                        key: "totalRuns",
                        label: t("crawlFrontier.console.runStats.totalRuns"),
                        value: runStats.total,
                      },
                      {
                        key: "active",
                        label: t("crawlFrontier.console.stats.active"),
                        value: runStats.active,
                      },
                      {
                        key: "failed",
                        label: t("crawlFrontier.console.runStats.failed"),
                        value: runStats.failed,
                        tone: runStats.failed > 0 ? "danger" : undefined,
                      },
                      {
                        key: "challenge",
                        label: t("crawlFrontier.console.runStats.challenge"),
                        value: runStats.challenge,
                      },
                      {
                        key: "pendingLlm",
                        label: t("crawlFrontier.console.runStats.pendingLlm"),
                        value: runStats.pendingLlm,
                      },
                      {
                        key: "seedFirst",
                        label: t("crawlFrontier.console.runStats.seedFirst"),
                        value: runStats.seedFirst,
                      },
                    ]}
                  />
                  <FilterBar
                    className="mt-4"
                    actions={
                      <>
                        <Button onClick={() => void loadRuns()}>{t("crawlFrontier.console.actions.refresh")}</Button>
                        <Button onClick={() => setRunFilters((current) => ({ ...current, search: "", profileId: undefined, status: undefined, executionMode: undefined, runRole: undefined, failureKind: undefined, warningFlag: undefined, seedStrategy: undefined }))}>{t("crawlFrontier.console.actions.reset")}</Button>
                        {canManage ? <Button type="primary" onClick={() => { runForm.setFieldsValue({ executionMode: "layered", maxDepth: 3, maxPages: 60 }); setRunModalOpen(true); }}>{t("crawlFrontier.console.actions.newRun")}</Button> : null}
                        {canManage && selectedRunIds.length > 0 ? <Button danger onClick={() => void bulkCancelRuns()}>{t("crawlFrontier.console.actions.cancelSelected")}</Button> : null}
                      </>
                    }
                  >
                    <FilterBar.Item width="lg">
                      <Input.Search
                        allowClear
                        value={runFilters.search}
                        onChange={(event) => setRunFilters((current) => ({ ...current, search: event.target.value }))}
                        placeholder={t("crawlFrontier.console.placeholders.searchRun")}
                        className="w-full"
                      />
                    </FilterBar.Item>
                    <FilterBar.Item width="lg">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.profile")} className="w-full" value={runFilters.profileId} onChange={(value) => setRunFilters((current) => ({ ...current, profileId: value }))} options={profiles.map((profile) => ({ label: profile.name, value: profile.id }))} />
                    </FilterBar.Item>
                    <FilterBar.Item width="sm">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.status")} className="w-full" value={runFilters.status} onChange={(value) => setRunFilters((current) => ({ ...current, status: value }))} options={["pending", "queued", "running", "completed", "failed", "canceled"].map((value) => ({ label: value, value }))} />
                    </FilterBar.Item>
                    <FilterBar.Item width="sm">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.mode")} className="w-full" value={runFilters.executionMode} onChange={(value) => setRunFilters((current) => ({ ...current, executionMode: value }))} options={["layered", "native", "hybrid"].map((value) => ({ label: value, value }))} />
                    </FilterBar.Item>
                    <FilterBar.Item width="sm">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.runRole")} className="w-full" value={runFilters.runRole} onChange={(value) => setRunFilters((current) => ({ ...current, runRole: value }))} options={[{ label: "active", value: "active" }, { label: "shadow", value: "shadow" }]} />
                    </FilterBar.Item>
                    <FilterBar.Item width="md">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.failureKind")} className="w-full" value={runFilters.failureKind} onChange={(value) => setRunFilters((current) => ({ ...current, failureKind: value }))} options={["challenge_detected", "ssrf_blocked", "no_frontier_candidates", "network_tunnel_error", "llm_judge_parse_failed"].map((value) => ({ label: value, value }))} />
                    </FilterBar.Item>
                    <FilterBar.Item width="md">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.warningFlag")} className="w-full" value={runFilters.warningFlag} onChange={(value) => setRunFilters((current) => ({ ...current, warningFlag: value }))} options={["llm_judge_parse_failed", "llm_judge_circuit_open", "challenge_detected", "ssrf_blocked", "retry_demoted_to_normal"].map((value) => ({ label: value, value }))} />
                    </FilterBar.Item>
                    <FilterBar.Item width="md">
                      <Select allowClear placeholder={t("crawlFrontier.console.filters.seedStrategy")} className="w-full" value={runFilters.seedStrategy} onChange={(value) => setRunFilters((current) => ({ ...current, seedStrategy: value }))} options={["auto", "seed_first", "frontier_first", "frontier_only"].map((value) => ({ label: value, value }))} />
                    </FilterBar.Item>
                  </FilterBar>
                </Card>
                <Card className="content-card">
                  <Table rowKey="id" columns={runColumns} dataSource={runs} loading={loadingRuns} pagination={{ pageSize: 10 }} rowSelection={canManage ? { selectedRowKeys: selectedRunIds, onChange: (keys) => setSelectedRunIds(keys.map((key) => String(key))), getCheckboxProps: (record) => ({ disabled: record.status === "completed" || record.status === "canceled" }) } : undefined} scroll={{ x: "max-content" }} />
                </Card>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={profileEditor.editing ? t("crawlFrontier.console.profileEditor.editTitle") : t("crawlFrontier.console.profileEditor.createTitle")}
        open={profileEditor.open}
        onClose={() => setProfileEditor({ open: false, editing: null })}
        width="min(1120px, 100vw)"
        extra={<Space><Button onClick={() => setProfileEditor({ open: false, editing: null })}>{t("crawlFrontier.console.actions.close")}</Button><Button type="primary" loading={saving} disabled={!canManage} onClick={() => void profileForm.submit()}>{t("crawlFrontier.console.actions.save")}</Button></Space>}
      >
        <Form layout="vertical" form={profileForm} onFinish={submitProfile}>
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Alert type={profileRawMode ? "warning" : "info"} showIcon message={profileRawMode ? t("crawlFrontier.console.profileEditor.rawMode.enabled") : t("crawlFrontier.console.profileEditor.rawMode.disabled")} />
            {resolvedProfileConfig.error ? <Alert type="error" showIcon message={resolvedProfileConfig.error} /> : null}
            <Tabs items={[
              {
                key: "basic",
                label: t("crawlFrontier.console.profileEditor.tabs.basic"),
                children: (
                  <Row gutter={[16, 16]}>
                    <Col xs={24} lg={16}>
                      <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.identity")}>
                        <Row gutter={[16, 16]}>
                          <Col xs={24} md={12}><Form.Item name="name" label={t("crawlFrontier.console.profileEditor.fields.profileName")} rules={[{ required: true }]}><Input disabled={profileRawMode} /></Form.Item></Col>
                          <Col xs={24} md={12}><Form.Item name="matchHost" label={t("crawlFrontier.console.profileEditor.fields.matchHost")} rules={[{ required: true }]}><Input disabled={profileRawMode} placeholder={t("crawlFrontier.console.placeholders.matchHost")} /></Form.Item></Col>
                          <Col xs={24}><Form.Item name="description" label={t("crawlFrontier.console.profileEditor.fields.description")}><Input disabled={profileRawMode} /></Form.Item></Col>
                        </Row>
                      </Card>
                    </Col>
                    <Col xs={24} lg={8}>
                      <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.status")}>
                        <Form.Item name="executionMode" label={t("crawlFrontier.console.profileEditor.fields.executionMode")}><Select disabled={profileRawMode} options={["layered", "native", "hybrid"].map((value) => ({ label: value, value }))} /></Form.Item>
                        <Form.Item name="isActive" valuePropName="checked" label={t("crawlFrontier.console.stats.active")}><Switch disabled={profileRawMode} /></Form.Item>
                        <Form.Item name="workflowId" label={t("crawlFrontier.console.profileEditor.fields.workflowBinding")}>
                          <Select allowClear disabled={profileRawMode} options={workflowOptions} placeholder={t("crawlFrontier.console.placeholders.optionalWorkflow")} />
                        </Form.Item>
                        <Form.Item name="workflowBindingMode" label={t("crawlFrontier.console.profileEditor.fields.workflowVersionMode")}>
                          <Select disabled={profileRawMode} options={[{ label: "published", value: "published" }, { label: "pinned", value: "pinned" }]} />
                        </Form.Item>
                        <Form.Item name="workflowVersionId" label={t("crawlFrontier.console.profileEditor.fields.pinnedWorkflowVersion")}>
                          <Input disabled={profileRawMode} placeholder={t("crawlFrontier.console.placeholders.workflowVersionId")} />
                        </Form.Item>
                        <Form.Item name={["config", "sourceTier"]} label={t("crawlFrontier.console.profileEditor.fields.sourceTier")}><Select disabled={profileRawMode} options={["tier1", "tier2", "tier3"].map((value) => ({ label: value, value }))} /></Form.Item>
                      </Card>
                    </Col>
                    <Col xs={24}>
                      <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.matchPreview")}>
                        <Space wrap style={{ display: "flex" }}>
                          <Form.Item name="previewUrl" label={t("crawlFrontier.console.profileEditor.fields.previewUrl")} className="min-w-0 flex-1 md:min-w-[360px]"><Input placeholder={t("crawlFrontier.console.placeholders.previewUrl")} /></Form.Item>
                          <Button loading={profilePreviewLoading} onClick={() => void previewProfileMatch()}>{t("crawlFrontier.console.actions.previewMatch")}</Button>
                        </Space>
                        {profileMatchPreview ? (
                          <Space direction="vertical" size="middle" style={{ width: "100%" }} className="!mt-4">
                            <Alert
                              type={profileMatchPreview.draftMatches ? "success" : "warning"}
                              showIcon
                              message={profileMatchPreview.draftMatches ? t("crawlFrontier.console.profileEditor.matchPreview.draftMatches") : t("crawlFrontier.console.profileEditor.matchPreview.draftMismatch")}
                              description={
                                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                                  <Typography.Text>{profileMatchPreview.draftMatchReason}</Typography.Text>
                                  <Space wrap>{summarizeProfileConfig(profileMatchPreview.draft.config).map((entry) => <Tag key={`draft-${entry}`}>{entry}</Tag>)}</Space>
                                </Space>
                              }
                            />
                            <Alert
                              type={profileMatchPreview.activeMatch ? "info" : "warning"}
                              showIcon
                              message={profileMatchPreview.activeMatch ? t("crawlFrontier.console.profileEditor.matchPreview.activeMatch", { name: profileMatchPreview.activeMatch.name }) : t("crawlFrontier.console.profileEditor.matchPreview.noActiveMatch")}
                              description={
                                profileMatchPreview.activeMatch ? (
                                  <Space wrap>{summarizeProfileConfig(profileMatchPreview.activeMatch.config).map((entry) => <Tag key={`active-${entry}`}>{entry}</Tag>)}</Space>
                                ) : (
                                  t("crawlFrontier.console.profileEditor.matchPreview.draftOnly")
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
                label: t("crawlFrontier.console.profileEditor.tabs.strategy"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.seedDiscovery")}>
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "strategy"]} label={t("crawlFrontier.console.profileForm.strategy")}><Select disabled={profileRawMode} options={["auto", "seed_first", "frontier_first", "frontier_only"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "mode"]} label={t("crawlFrontier.console.profileForm.mode")}><Select disabled={profileRawMode} options={["robots", "common_paths", "sitemap_only", "disabled"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "freshnessWindowHours"]} label={t("crawlFrontier.console.profileForm.freshnessWindowHours")}><InputNumber min={1} max={24 * 365} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "maxSeedUrls"]} label={t("crawlFrontier.console.profileForm.maxSeedUrls")}><InputNumber min={1} max={500} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "topologyBudgetPages"]} label={t("crawlFrontier.console.profileForm.topologyBudgetPages")}><InputNumber min={1} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "topologyBudgetDepth"]} label={t("crawlFrontier.console.profileForm.topologyBudgetDepth")}><InputNumber min={1} max={8} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "minCandidates"]} label={t("crawlFrontier.console.profileForm.minCandidates")}><InputNumber min={1} max={200} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "minArticleRatio"]} label={t("crawlFrontier.console.profileForm.minArticleRatio")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "maxNoiseRatio"]} label={t("crawlFrontier.console.profileForm.maxNoiseRatio")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "seedDiscovery", "qualityThresholds", "minFreshRatio"]} label={t("crawlFrontier.console.profileForm.minFreshRatio")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                      </Row>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={12}>
                        <Card
                          size="small"
                          title={t("crawlFrontier.profile.strategy.layeredFrontier")}
                        >
                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "maxDepth"]} label={t("crawlFrontier.console.profileForm.maxDepth")}><InputNumber min={1} max={8} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "maxPages"]} label={t("crawlFrontier.console.profileForm.maxPages")}><InputNumber min={1} max={500} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "maxChildrenPerNode"]} label={t("crawlFrontier.console.profileForm.maxChildrenPerNode")}><InputNumber min={1} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "scoreThreshold"]} label={t("crawlFrontier.console.profileForm.scoreThreshold")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "layeredOptions", "paginationKeepCount"]} label={t("crawlFrontier.console.profileForm.paginationKeepCount")}><InputNumber min={1} max={20} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                          </Row>
                        </Card>
                      </Col>
                      <Col xs={24} lg={12}>
                        <Card
                          size="small"
                          title={t("crawlFrontier.profile.strategy.nativeDeepCrawl")}
                        >
                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={8}><Form.Item name={["config", "nativeOptions", "deepCrawlStrategy", "type"]} label={t("crawlFrontier.console.profileForm.type")}><Select disabled={profileRawMode} options={["auto", "BFSDeepCrawlStrategy", "BestFirstCrawlingStrategy"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                            <Col xs={24} md={8}><Form.Item name={["config", "nativeOptions", "fallbackToLayered"]} valuePropName="checked" label={t("crawlFrontier.console.profileForm.fallbackToLayered")}><Switch disabled={profileRawMode} /></Form.Item></Col>
                            <Col xs={24} md={4}><Form.Item name={["config", "nativeOptions", "minAcceptedResults"]} label={t("crawlFrontier.profile.strategy.minAcceptedResults")}><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={4}><Form.Item name={["config", "nativeOptions", "minArticleResults"]} label={t("crawlFrontier.console.profileForm.minArticleResults")}><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "nativeOptions", "deepCrawlStrategy", "params", "max_depth"]} label={t("crawlFrontier.console.profileForm.max_depth")}><InputNumber min={1} max={8} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col xs={24} md={6}><Form.Item name={["config", "nativeOptions", "deepCrawlStrategy", "params", "max_pages"]} label={t("crawlFrontier.console.profileForm.max_pages")}><InputNumber min={1} max={500} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                          </Row>
                        </Card>
                      </Col>
                    </Row>
                  </Space>
                ),
              },
              {
                key: "llm",
                label: t("crawlFrontier.console.profileEditor.tabs.llmLocaleDom"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.llmAssist")}>
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "enabled"]} valuePropName="checked" label={t("crawlFrontier.console.profileForm.enabled")}><Switch disabled={profileRawMode} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "recallMode"]} label={t("crawlFrontier.console.profileForm.recallMode")}><Select disabled={profileRawMode} options={["high_recall", "balanced", "low_cost"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "minJudgeConfidence"]} label={t("crawlFrontier.console.profileForm.llmAssist.minJudgeConfidence")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "shadowEvaluationRuns"]} label={t("crawlFrontier.console.profileForm.shadowEvaluationRuns")}><InputNumber min={1} max={10} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "home"]} label={t("crawlFrontier.console.profileForm.home")}><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "category"]} label={t("crawlFrontier.console.profileForm.category")}><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "list"]} label={t("crawlFrontier.console.profileForm.list")}><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item name={["config", "llmAssist", "candidateBudgetByPageType", "article"]} label={t("crawlFrontier.console.profileForm.article")}><InputNumber min={0} max={100} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name={["config", "llmAssist", "autoPublishThresholds", "minArticleLift"]} label={t("crawlFrontier.console.profileForm.minArticleLift")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name={["config", "llmAssist", "autoPublishThresholds", "minNoiseReduction"]} label={t("crawlFrontier.console.profileForm.minNoiseReduction")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name={["config", "llmAssist", "autoPublishThresholds", "minJudgeConfidence"]} label={t("crawlFrontier.console.profileForm.autoPublishThresholds.minJudgeConfidence")}><InputNumber min={0} max={1} step={0.05} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                      </Row>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={12}>
                        <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.localeHostScope")}>
                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={8}><Form.Item name={["config", "hostScope"]} label={t("crawlFrontier.console.profileForm.hostScope")}><Select disabled={profileRawMode} options={["registrable_domain", "strict_hosts"].map((value) => ({ label: value, value }))} /></Form.Item></Col>
                            <Col xs={24} md={8}><Form.Item name={["config", "localeScope", "locale"]} label={t("crawlFrontier.console.profileEditor.fields.preferredLocale")}><Input disabled={profileRawMode} placeholder={t("crawlFrontier.console.placeholders.locale")} /></Form.Item></Col>
                            <Col xs={24} md={8}><Form.Item name={["config", "localeScope", "acceptLanguages"]} label={t("crawlFrontier.console.profileForm.acceptLanguages")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "allowedHosts"]} label={t("crawlFrontier.console.profileForm.allowedHosts")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "allowedDomains"]} label={t("crawlFrontier.console.profileForm.allowedDomains")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "blockedDomains"]} label={t("crawlFrontier.console.profileForm.blockedDomains")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "localeScope", "denyUrlPatterns"]} label={t("crawlFrontier.console.profileForm.denyUrlPatterns")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                            <Col xs={24}><Form.Item name={["config", "localeScope", "denyHostPatterns"]} label={t("crawlFrontier.console.profileForm.denyHostPatterns")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item></Col>
                          </Row>
                        </Card>
                      </Col>
                      <Col xs={24} lg={12}>
                        <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.domScopesKeywords")}>
                          <Form.Item name={["config", "domLinkScopes"]} label={t("crawlFrontier.console.profileForm.domLinkScopes")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                          <Form.Item name={["config", "domLinkExcludeSelectors"]} label={t("crawlFrontier.console.profileForm.domLinkExcludeSelectors")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                          <Form.Item name={["config", "priorityKeywords"]} label={t("crawlFrontier.console.profileForm.priorityKeywords")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                          <Form.Item name={["config", "denyKeywords"]} label={t("crawlFrontier.console.profileForm.denyKeywords")}><Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} /></Form.Item>
                        </Card>
                      </Col>
                    </Row>
                  </Space>
                ),
              },
              {
                key: "patterns",
                label: t("crawlFrontier.console.profileEditor.tabs.patternsJson"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.urlPatterns")}>
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
                    <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.pageTypeSignalsFreshness")}>
                      <Row gutter={[16, 16]}>
                        {(["home", "category", "list", "article", "deny"] as const).map((key) => (
                          <Col xs={24} lg={12} key={`signal-${key}`}>
                            <div className="surface-inset">
                              <div className="kicker mb-2">{`${key} signals`}</div>
                              <Form.Item name={["config", "pageTypeSignals", key, "patterns"]} label={t("crawlFrontier.console.profileForm.patterns")}>
                                <Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} />
                              </Form.Item>
                              <Form.Item name={["config", "pageTypeSignals", key, "keywords"]} label={t("crawlFrontier.console.profileForm.keywords")}>
                                <Select mode="tags" disabled={profileRawMode} tokenSeparators={[","]} />
                              </Form.Item>
                            </div>
                          </Col>
                        ))}
                        <Col xs={24}>
                          <div className="surface-inset">
                            <div className="kicker mb-2">{t("crawlFrontier.console.profileEditor.cards.freshnessRules")}</div>
                            <Row gutter={[16, 16]}>
                              <Col xs={24} md={8}><Form.Item name={["config", "freshnessRules", "recentHours"]} label={t("crawlFrontier.console.profileForm.recentHours")}><InputNumber min={1} max={24 * 30} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                              <Col xs={24} md={8}><Form.Item name={["config", "freshnessRules", "weekHours"]} label={t("crawlFrontier.console.profileForm.weekHours")}><InputNumber min={1} max={24 * 90} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                              <Col xs={24} md={8}><Form.Item name={["config", "freshnessRules", "monthHours"]} label={t("crawlFrontier.console.profileForm.monthHours")}><InputNumber min={1} max={24 * 365} disabled={profileRawMode} style={{ width: "100%" }} /></Form.Item></Col>
                            </Row>
                          </div>
                        </Col>
                      </Row>
                    </Card>
                    <Card size="small" title={t("crawlFrontier.console.profileEditor.cards.advancedJson")}>
                      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                        <Space wrap>
                          <Typography.Text strong>Raw JSON mode</Typography.Text>
                          <Switch checked={profileRawMode} onChange={(checked) => void handleProfileRawModeChange(checked)} />
                        </Space>
                        <Form.Item name="configJson" label={t("crawlFrontier.console.profileForm.configJson")}>
                          <Input.TextArea rows={18} spellCheck={false} disabled={!profileRawMode} />
                        </Form.Item>
                        <Collapse items={[{ key: "preview", label: "Resolved config preview", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(resolvedProfileConfig.config ?? {})}</Typography.Paragraph> }]} />
                      </Space>
                    </Card>
                  </Space>
                ),
              },
            ]} />
          </Space>
        </Form>
      </Drawer>

      <Modal open={versionsOpen} title={t("crawlFrontier.console.modals.profileVersions")} onCancel={() => { setVersionsOpen(false); setCurrentVersionProfile(null); }} footer={null} width="min(920px, calc(100vw - 32px))">
        <Table rowKey="id" dataSource={versions} pagination={false} columns={[
          { title: "Version", dataIndex: "version", key: "version", width: 90 },
          { title: "Mode", dataIndex: "executionMode", key: "executionMode", width: 120 },
          { title: "Created", key: "createdAt", width: 180, render: (_, record) => formatDateTime(record.createdAt) },
          { title: "Summary", key: "summary", render: (_, record) => <Space wrap>{summarizeProfileConfig(asRecord(record.config) ?? {}).map((entry) => <Tag key={`${record.id}-${entry}`}>{entry}</Tag>)}</Space> },
          { title: "Actions", key: "actions", width: 120, render: (_, record) => currentVersionProfile ? <Button size="small" danger onClick={() => void rollbackVersion(currentVersionProfile.id, record.version)}>Rollback</Button> : null },
        ]} scroll={{ x: "max-content" }} />
      </Modal>

      <Modal open={runModalOpen} title={t("crawlFrontier.console.modals.createRun")} onCancel={() => setRunModalOpen(false)} onOk={() => void runForm.submit()} okButtonProps={{ loading: saving, disabled: !canManage }}>
        <Form layout="vertical" form={runForm} onFinish={submitRun}>
          <Form.Item name="seedUrl" label={t("crawlFrontier.console.runForm.seedUrl")} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="profileId" label={t("crawlFrontier.console.filters.profile")} extra={t("crawlFrontier.console.runForm.profileHelp")}><Select allowClear options={profiles.map((profile) => ({ label: `${profile.name} (${profile.matchHost})`, value: profile.id }))} /></Form.Item>
          <Form.Item name="executionMode" label={t("crawlFrontier.console.runForm.executionModeOverride")}><Select allowClear options={["layered", "native", "hybrid"].map((value) => ({ label: value, value }))} /></Form.Item>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}><Form.Item name="maxDepth" label={t("crawlFrontier.console.runForm.maxDepth")}><InputNumber min={1} max={8} style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="maxPages" label={t("crawlFrontier.console.runForm.maxPages")}><InputNumber min={1} max={500} style={{ width: "100%" }} /></Form.Item></Col>
          </Row>
          <Form.Item name="keywordsText" label={t("crawlFrontier.console.runForm.keywords")} extra={t("crawlFrontier.console.runForm.keywordsHelp")}><Input.TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={t("crawlFrontier.console.runDrawer.title")}
        open={runDrawerOpen}
        onClose={() => {
          setRunDrawerOpen(false);
          setSelectedRun(null);
          setSelectedWorkflowRun(null);
          setSelectedWorkflowCandidate(null);
          setSelectedNodeIds([]);
        }}
        width="min(1320px, 100vw)"
      >
        {selectedRun ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card size="small">
              <Space direction="vertical" size="small" style={{ width: "100%" }}>
                <Space wrap size={[4, 4]}>
                  <Tag color={runStatusColors[selectedRun.status]}>{selectedRun.status}</Tag>
                  {selectedRunDiagnostics?.runRole ? <Tag>{selectedRunDiagnostics.runRole}</Tag> : null}
                  {selectedRunDiagnostics?.failureKind ? <Tag>{selectedRunDiagnostics.failureKind}</Tag> : null}
                  {selectedRunDiagnostics?.seedStrategy ? <Tag>{`seed:${selectedRunDiagnostics.seedStrategy}`}</Tag> : null}
                  {selectedRunDiagnostics?.seedMethod ? <Tag>{selectedRunDiagnostics.seedMethod}</Tag> : null}
                  {selectedRunDiagnostics?.fallbackStage ? <Tag>{selectedRunDiagnostics.fallbackStage}</Tag> : null}
                  {selectedRunDiagnostics?.pendingLlmJobs ? <Tag>{`pending:${selectedRunDiagnostics.pendingLlmJobs}`}</Tag> : null}
                  {selectedWorkflowRun?.workflowOrigin ? (
                    <Tag>
                      {selectedWorkflowRun.workflowOrigin}
                    </Tag>
                  ) : null}
                  {selectedWorkflowRun?.workflowVersion ? (
                    <Tag>{`workflow:v${selectedWorkflowRun.workflowVersion.version}`}</Tag>
                  ) : null}
                  {selectedRunDiagnostics?.warningFlags.map((flag) => <Tag key={`run-${flag}`} color="warning">{flag}</Tag>)}
                </Space>
                <Typography.Text>{selectedRun.seedUrl}</Typography.Text>
                <Typography.Text type="secondary">{selectedRun.profile?.name ?? "auto"} / {selectedRun.executionMode}</Typography.Text>
              </Space>
            </Card>

            <Tabs activeKey={runDrawerTab} onChange={setRunDrawerTab} items={[
              {
                key: "overview",
                label: t("crawlFrontier.console.runDrawer.tabs.overview"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} md={6}><Card size="small"><Statistic title={t("crawlFrontier.console.runDrawer.overview.pages")} value={selectedRun.pageCount} /></Card></Col>
                      <Col xs={24} md={6}><Card size="small"><Statistic title={t("crawlFrontier.console.runDrawer.overview.nodes")} value={selectedRun.nodeCount} /></Card></Col>
                      <Col xs={24} md={6}><Card size="small"><Statistic title={t("crawlFrontier.console.runDrawer.overview.articles")} value={selectedRun.articleCount} /></Card></Col>
                      <Col xs={24} md={6}><Card size="small"><Statistic title={t("crawlFrontier.console.runDrawer.overview.pendingLlmJobs")} value={selectedRunSummary?.pendingLlmJudgeJobs ?? 0} /></Card></Col>
                    </Row>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.overview.coverageDiagnostics")}>
                      <Descriptions size="small" column={1} bordered>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.coverageByType")}>{formatCountSummary(selectedRunSummary?.coverageByPageType)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.coverageByDepth")}>{formatCountSummary(selectedRunSummary?.coverageByDepth)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.candidateStats")}>{formatCountSummary(selectedRunSummary?.candidateStats)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.rejectionCounts")}>{formatCountSummary(selectedRunSummary?.rejectionCounts)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.run.nativeAcceptedSelected")}>
                          {asNumber(selectedRunRootDiagnosis?.nativeAcceptedResults) !== null ||
                          asNumber(selectedRunRootDiagnosis?.nativeSelectedResults) !== null
                            ? `${asNumber(selectedRunRootDiagnosis?.nativeAcceptedResults) ?? 0} ${t("crawlFrontier.run.acceptedLabel")} / ${asNumber(selectedRunRootDiagnosis?.nativeSelectedResults) ?? 0} ${t("crawlFrontier.run.selectedLabel")}`
                            : "-"}
                        </Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.judgeSummary")}>
                          {formatCountSummary(asRecord(selectedRunSummary?.judgeSummary)?.methods)}
                          {asNumber(asRecord(selectedRunSummary?.judgeSummary)?.averageConfidence) !== null ? ` · avg ${formatNumber(asRecord(selectedRunSummary?.judgeSummary)?.averageConfidence)}` : ""}
                        </Descriptions.Item>
                      </Descriptions>
                    </Card>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.overview.rootDiagnosis")}>
                      <Collapse items={[
                        { key: "structured", label: "Structured diagnosis", children: <Descriptions size="small" column={2}><Descriptions.Item label={t("crawlFrontier.console.labels.failureKind")}>{selectedRunDiagnostics?.failureKind ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.lastError")}>{selectedRun.lastError ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.startedAt")}>{formatDateTime(selectedRun.startedAt)}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.finishedAt")}>{formatDateTime(selectedRun.finishedAt)}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.run.nativeAccepted")}>{asNumber(selectedRunRootDiagnosis?.nativeAcceptedResults) ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.run.nativeSelected")}>{asNumber(selectedRunRootDiagnosis?.nativeSelectedResults) ?? "-"}</Descriptions.Item></Descriptions> },
                        { key: "json", label: "Root diagnosis JSON", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(selectedRunRootDiagnosis)}</Typography.Paragraph> },
                      ]} />
                    </Card>
                  </Space>
                ),
              },
              {
                key: "strategy",
                label: t("crawlFrontier.console.runDrawer.tabs.strategyTrace"),
                children: (
                  <Card size="small">
                    <Steps
                      direction="vertical"
                      current={-1}
                      items={(selectedRunSummary?.trace ?? []).map((step) => ({
                        title: step.label,
                        description: <Space direction="vertical" size={4}><Typography.Text>{step.detail ?? "-"}</Typography.Text><Space wrap><Tag color={step.status === "failed" ? "error" : step.status === "warning" ? "warning" : step.status === "active" ? "processing" : step.status === "completed" ? "success" : undefined}>{step.status}</Tag>{(step.tags ?? []).map((entry) => <Tag key={`${step.key}-${entry}`}>{entry}</Tag>)}</Space></Space>,
                        status: step.status === "failed" ? "error" : step.status === "active" ? "process" : step.status === "completed" ? "finish" : "wait",
                      }))}
                    />
                  </Card>
                ),
              },
              {
                key: "workflow",
                label: t("crawlFrontier.console.runDrawer.tabs.workflowTrace"),
                children: !selectedWorkflowRun ? (
                  loadingWorkflowRun ? (
                    <div style={{ display: "flex", justifyContent: "center", padding: "4rem 0" }}>
                      <Spin />
                    </div>
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message={t("crawlFrontier.console.runDrawer.workflow.noTrace")}
                    />
                  )
                ) : (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card
                      size="small"
                      title={t("crawlFrontier.console.runDrawer.workflow.runCard")}
                      extra={
                        <Space wrap>
                          <Button onClick={() => void reloadSelectedRun()} loading={saving}>
                            {t("crawlFrontier.console.actions.refresh")}
                          </Button>
                          <Button
                            onClick={() => {
                              if (!selectedWorkflowRun.workflow?.id) {
                                return;
                              }
                              setWorkflowStudioSelection(selectedWorkflowRun.workflow.id);
                              setActiveConsoleTab("workflow");
                              setRunDrawerOpen(false);
                            }}
                            disabled={!selectedWorkflowRun.workflow?.id}
                          >
                            {t("crawlFrontier.console.runDrawer.workflow.openInStudio")}
                          </Button>
                          <Tooltip
                            title={
                              selectedWorkflowRun.workflow?.id
                                ? undefined
                                : t("crawlFrontier.console.runDrawer.workflow.replayLegacyHint")
                            }
                          >
                          <Button
                            type="primary"
                            ghost
                            onClick={() => void replayWorkflowRun(selectedWorkflowRun.id)}
                            loading={replayingWorkflowRun}
                            disabled={!selectedWorkflowRun.workflow?.id}
                          >
                            {t("crawlFrontier.console.runDrawer.workflow.replay")}
                          </Button>
                          </Tooltip>
                        </Space>
                      }
                    >
                      {selectedWorkflowRun.workflowOrigin === "legacy_bridge" ? (
                        <Alert
                          type="info"
                          showIcon
                          className="!mb-4"
                          message={t("crawlFrontier.console.runDrawer.workflow.legacyBridgeNotice")}
                        />
                      ) : null}
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}>
                          <Statistic title={t("crawlFrontier.console.runDrawer.workflow.workflowSteps")} value={selectedWorkflowRun.stepCount} />
                        </Col>
                        <Col xs={24} md={6}>
                          <Statistic title={t("crawlFrontier.console.runDrawer.workflow.candidates")} value={selectedWorkflowRun.candidateCount} />
                        </Col>
                        <Col xs={24} md={6}>
                          <Statistic title={t("crawlFrontier.console.runDrawer.workflow.selected")} value={selectedWorkflowRun.selectedCount} />
                        </Col>
                        <Col xs={24} md={6}>
                          <Statistic
                            title={t("crawlFrontier.console.runDrawer.workflow.systemEvents")}
                            value={selectedWorkflowRun.systemEvents.length}
                          />
                        </Col>
                      </Row>
                      <Descriptions
                        size="small"
                        column={2}
                        bordered
                        className="!mt-4"
                      >
                        <Descriptions.Item label={t("crawlFrontier.console.labels.workflow")}>
                          {selectedWorkflowRun.workflow?.name ?? "Legacy bridge"}
                        </Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.version")}>
                          {selectedWorkflowRun.workflowVersion
                            ? `v${selectedWorkflowRun.workflowVersion.version}`
                            : "-"}
                        </Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.origin")}>
                          {selectedWorkflowRun.workflowOrigin}
                        </Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.runKind")}>
                          {selectedWorkflowRun.runKind}
                        </Descriptions.Item>
                      </Descriptions>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} xl={10}>
                        <Card size="small" title={t("crawlFrontier.console.runDrawer.workflow.stepTimeline")}>
                          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                            {selectedWorkflowRun.stepResults.map((step) => (
                              <div key={step.stepKey ?? step.nodeId} className="surface-inset">
                                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                  <Space wrap size={[6, 6]}>
                                    <Tag color={workflowStepColor(step.status)}>
                                      {step.status}
                                    </Tag>
                                    <Tag>{step.nodeType}</Tag>
                                    <span className="font-mono text-xs text-muted-foreground">{`${step.durationMs}ms`}</span>
                                  </Space>
                                  <Typography.Text strong>{step.label}</Typography.Text>
                                  <Typography.Text type="secondary">
                                    {formatWorkflowStepSummary(step)}
                                  </Typography.Text>
                                  {step.sampleUrls.length > 0 ? (
                                    <Space wrap size={[4, 4]}>
                                      {step.sampleUrls.slice(0, 3).map((sampleUrl) => (
                                        <Tag key={`${step.nodeId}-${sampleUrl}`}>{sampleUrl}</Tag>
                                      ))}
                                    </Space>
                                  ) : null}
                                  {step.error ? (
                                    <Alert type="error" showIcon message={step.error} />
                                  ) : null}
                                </Space>
                              </div>
                            ))}
                          </Space>
                        </Card>
                      </Col>
                      <Col xs={24} xl={14}>
                        <Space direction="vertical" size="large" style={{ width: "100%" }}>
                          <Card size="small" title={t("crawlFrontier.console.runDrawer.workflow.candidates")}>
                            <Table
                              rowKey="id"
                              columns={workflowCandidateColumns}
                              dataSource={selectedWorkflowRun.candidates}
                              pagination={{ pageSize: 8 }}
                              size="small"
                              scroll={{ x: "max-content" }}
                            />
                          </Card>
                          <div className="flex flex-col gap-2">
                            <p className="kicker m-0">{t("crawlFrontier.console.runDrawer.workflow.systemEventsTitle")}</p>
                            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                              {selectedWorkflowRun.systemEvents.length === 0 ? (
                                <Typography.Text type="secondary">
                                  No workflow system events were recorded.
                                </Typography.Text>
                              ) : (
                                selectedWorkflowRun.systemEvents.map((event) => (
                                  <div key={event.id ?? `${event.eventType}-${event.timestamp}`} className="hairline-b py-2 last:border-b-0">
                                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                      <Space wrap size={[6, 6]}>
                                        <Tag color={workflowEventColor(event.level)}>{event.level}</Tag>
                                        <Tag>{event.eventType}</Tag>
                                        {event.nodeType ? <Tag>{event.nodeType}</Tag> : null}
                                        {event.triggerReason ? (
                                          <Tag>{event.triggerReason}</Tag>
                                        ) : null}
                                      </Space>
                                      <Typography.Text>{event.message}</Typography.Text>
                                      <Typography.Text type="secondary">
                                        {formatDateTime(event.timestamp)}
                                      </Typography.Text>
                                      {(event.beforeCount !== null && event.beforeCount !== undefined) ||
                                      (event.afterCount !== null && event.afterCount !== undefined) ? (
                                        <Space wrap size={[4, 4]}>
                                          <span className="font-mono text-xs text-muted-foreground">{`before ${event.beforeCount ?? 0}`}</span>
                                          <span className="font-mono text-xs text-muted-foreground">{`after ${event.afterCount ?? 0}`}</span>
                                          <span className="font-mono text-xs text-muted-foreground">{`rescued ${event.rescuedCount ?? 0}`}</span>
                                        </Space>
                                      ) : null}
                                      {event.details ? (
                                        <Typography.Paragraph
                                          className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}
                                        >
                                          {stringifyJson(event.details)}
                                        </Typography.Paragraph>
                                      ) : null}
                                    </Space>
                                  </div>
                                ))
                              )}
                            </Space>
                          </div>
                        </Space>
                      </Col>
                    </Row>
                  </Space>
                ),
              },
              {
                key: "nodes",
                label: t("crawlFrontier.console.runDrawer.tabs.nodes"),
                children: (
                  <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                    <Card size="small">
                      <Space wrap style={{ display: "flex", alignItems: "flex-end" }}>
                        <Input allowClear value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} placeholder={t("crawlFrontier.console.placeholders.searchNode")} style={{ width: 260 }} />
                        <Select value={nodeStatusFilter} onChange={setNodeStatusFilter} style={{ width: 160 }} options={[{ label: t("crawlFrontier.console.runDrawer.nodes.allStatuses"), value: "all" }, ...(["pending", "queued", "running", "completed", "failed", "skipped", "canceled"] as const).map((value) => ({ label: value, value }))]} />
                        <Select value={nodePageTypeFilter} onChange={setNodePageTypeFilter} style={{ width: 160 }} options={[{ label: t("crawlFrontier.console.runDrawer.nodes.allPageTypes"), value: "all" }, ...uniqueStringList((selectedRun.nodes ?? []).map((node) => node.pageType)).map((value) => ({ label: value, value }))]} />
                        <Tooltip title={t("crawlFrontier.console.runDrawer.nodes.problemsOnlyHint")}><Space><Switch checked={nodeProblemsOnly} onChange={setNodeProblemsOnly} /><Typography.Text>{t("crawlFrontier.console.runDrawer.nodes.problemsOnly")}</Typography.Text></Space></Tooltip>
                        {selectedNodeIds.length > 0 ? <Button onClick={() => void bulkRetryNodes()}>{t("crawlFrontier.console.runDrawer.nodes.retrySelected")}</Button> : null}
                      </Space>
                    </Card>
                    <Table<NodeTreeRow> rowKey="id" columns={nodeColumns} dataSource={selectedNodesTree} pagination={{ pageSize: 20 }} rowSelection={canManage ? { selectedRowKeys: selectedNodeIds, onChange: (keys) => setSelectedNodeIds(keys.map((key) => String(key))), getCheckboxProps: (record) => ({ disabled: record.status !== "failed" && record.status !== "skipped" }) } : undefined} scroll={{ x: "max-content" }} />
                  </Space>
                ),
              },
              {
                key: "llm",
                label: t("crawlFrontier.console.runDrawer.tabs.llmShadow"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.llm.lifecycle")}>
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.runRole")}>{selectedRunDiagnostics?.runRole ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.pendingJudgeJobs")}>{selectedRunSummary?.pendingLlmJudgeJobs ?? 0}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.judgeCount")}>{formatNumber(asRecord(selectedRunSummary?.judgeSummary)?.count, 0)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.avgConfidence")}>{formatNumber(asRecord(selectedRunSummary?.judgeSummary)?.averageConfidence)}</Descriptions.Item>
                      </Descriptions>
                      <Space wrap size={[4, 4]} className="!mt-3">{(selectedRunSummary?.warningFlags ?? []).filter((flag) => flag.startsWith("llm_")).map((flag) => <Tag key={flag} color="warning">{flag}</Tag>)}</Space>
                      {canViewLogLinks ? (
                        <Space className="!mt-3">
                          <Button href={buildLlmLogsHref({ feature: "crawl_frontier_judge", runId: selectedRun.id, ...(selectedRun.profile?.id ? { profileId: selectedRun.profile.id } : {}) })}>View judge logs</Button>
                          <Button href={buildLlmLogsHref({ feature: "crawl_frontier_learn", runId: selectedRun.id, ...(selectedRun.profile?.id ? { profileId: selectedRun.profile.id } : {}) })}>View learn logs</Button>
                        </Space>
                      ) : null}
                    </Card>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.llm.shadowProfile")}>
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.shadowProfile")}>{asString(asRecord(selectedRunSummary?.shadowSummary)?.profileId) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.publishedProfile")}>{asString(asRecord(selectedRunSummary?.shadowSummary)?.publishedProfileId) ?? "-"}</Descriptions.Item>
                      </Descriptions>
                      <Collapse className="!mt-3" items={[{ key: "shadowComparison", label: "Shadow comparison", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(asRecord(selectedRunSummary?.shadowSummary)?.comparison)}</Typography.Paragraph> }]} />
                    </Card>
                  </Space>
                ),
              },
              {
                key: "diagnostics",
                label: t("crawlFrontier.console.runDrawer.tabs.seedDiagnostics"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.diagnostics.seedSummary")}>
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.strategy")}>{asString(asRecord(selectedRunSummary?.seedSummary)?.strategy) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.method")}>{asString(asRecord(selectedRunSummary?.seedSummary)?.method) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.origin")}>{asString(asRecord(selectedRunSummary?.seedSummary)?.origin) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.discoveryMode")}>{asString(asRecord(selectedRunSummary?.seedSummary)?.discoveryMode) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.fallback")}>{asString(asRecord(selectedRunSummary?.seedSummary)?.fallbackStage) ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.seedYield")}>{formatCountSummary(asRecord(asRecord(selectedRunSummary?.seedSummary)?.yield))}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.seedQuality")}>{stringifyJson(asRecord(asRecord(selectedRunSummary?.seedSummary)?.quality))}</Descriptions.Item>
                      </Descriptions>
                    </Card>
                    <Card size="small" title={t("crawlFrontier.console.labels.sitemapDiscovery")}>
                      <Descriptions size="small" column={2} bordered>
                        {buildSitemapDiagnosticRows(asRecord(asRecord(selectedRunSummary?.seedSummary)?.diagnostics)).map((row) => (
                          <Descriptions.Item key={row.key} label={row.label}>{row.value}</Descriptions.Item>
                        ))}
                      </Descriptions>
                    </Card>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.diagnostics.payloads")}>
                      <Collapse items={[
                        { key: "seedDiagnostics", label: "Seed diagnostics", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(asRecord(asRecord(selectedRunSummary?.seedSummary)?.diagnostics))}</Typography.Paragraph> },
                        { key: "runMetadata", label: "Run metadata", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(selectedRun.metadata)}</Typography.Paragraph> },
                      ]} />
                    </Card>
                  </Space>
                ),
              },
              {
                key: "repair",
                label: t("crawlFrontier.console.runDrawer.tabs.repairExtraction"),
                children: (
                  <Space direction="vertical" size="large" style={{ width: "100%" }}>
                    <Card size="small" title={t("crawlFrontier.console.runDrawer.repair.articleRepair")}>
                      <Row gutter={[16, 16]}>
                        <Col xs={24} md={6}><Statistic title={t("crawlFrontier.console.runDrawer.repair.articleLinkedNodes")} value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.available) ?? 0} /></Col>
                        <Col xs={24} md={6}><Statistic title={t("crawlFrontier.console.runDrawer.repair.repairAttempted")} value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.attempted) ?? 0} /></Col>
                        <Col xs={24} md={6}><Statistic title={t("crawlFrontier.console.runDrawer.repair.repairApplied")} value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.applied) ?? 0} /></Col>
                        <Col xs={24} md={6}><Statistic title={t("crawlFrontier.console.runDrawer.repair.repairFailed")} value={asNumber(asRecord(selectedRunSummary?.repairSummary)?.failed) ?? 0} /></Col>
                      </Row>
                      <Typography.Paragraph type="secondary" className="!mt-3">Use node inspection to see which fields were repaired, what extraction artifacts were available, and why repair was skipped or failed.</Typography.Paragraph>
                    </Card>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={8}>
                        <Card size="small" title={t("crawlFrontier.console.runDrawer.repair.repairedFields")}>
                          <Space wrap>{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.repairedFields) ?? {}).map(([field, count]) => <Tag key={`repair-field-${field}`}>{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.repairedFields) ?? {}).length === 0 ? <Typography.Text type="secondary">No repaired fields recorded.</Typography.Text> : null}</Space>
                        </Card>
                      </Col>
                      <Col xs={24} lg={8}>
                        <Card size="small" title={t("crawlFrontier.console.runDrawer.repair.missingFields")}>
                          <Space wrap>{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.missingFields) ?? {}).map(([field, count]) => <Tag key={`missing-field-${field}`}>{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.missingFields) ?? {}).length === 0 ? <Typography.Text type="secondary">No missing field diagnostics recorded.</Typography.Text> : null}</Space>
                        </Card>
                      </Col>
                      <Col xs={24} lg={8}>
                        <Card size="small" title={t("crawlFrontier.console.runDrawer.repair.repairErrorsModels")}>
                          <Space wrap>{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.errors) ?? {}).map(([field, count]) => <Tag key={`repair-error-${field}`}>{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.entries(asRecord(asRecord(selectedRunSummary?.repairSummary)?.models) ?? {}).map(([field, count]) => <Tag key={`repair-model-${field}`}>{`${field}:${asNumber(count) ?? 0}`}</Tag>)}{Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.errors) ?? {}).length === 0 && Object.keys(asRecord(asRecord(selectedRunSummary?.repairSummary)?.models) ?? {}).length === 0 ? <Typography.Text type="secondary">No model/error diagnostics recorded.</Typography.Text> : null}</Space>
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

      <Drawer
        title={t("crawlFrontier.console.workflowCandidate.title")}
        open={Boolean(selectedWorkflowCandidate)}
        onClose={() => setSelectedWorkflowCandidate(null)}
        width="min(760px, 100vw)"
      >
        {selectedWorkflowCandidate ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card size="small">
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {selectedWorkflowCandidate.title || selectedWorkflowCandidate.url}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {selectedWorkflowCandidate.url}
                </Typography.Text>
                <Space wrap size={[4, 4]}>
                  <Tag
                    color={
                      selectedWorkflowCandidate.status === "selected"
                        ? "success"
                        : selectedWorkflowCandidate.status === "rejected"
                          ? "error"
                          : undefined
                    }
                  >
                    {selectedWorkflowCandidate.status}
                  </Tag>
                  <Tag>{`source:${selectedWorkflowCandidate.sourceNodeId}`}</Tag>
                  {selectedWorkflowCandidate.pageType ? (
                    <Tag>{selectedWorkflowCandidate.pageType}</Tag>
                  ) : null}
                  {selectedWorkflowCandidate.rejectedReason ? (
                    <Tag>{selectedWorkflowCandidate.rejectedReason}</Tag>
                  ) : null}
                </Space>
              </Space>
            </Card>
            <Card size="small" title={t("crawlFrontier.console.workflowCandidate.summary")}>
              {(() => {
                const traceSummary = buildWorkflowCandidateTraceSummary(
                  selectedWorkflowCandidate,
                );
                const traceChain = buildWorkflowCandidateTraceChain(
                  selectedWorkflowCandidate,
                );
                return (
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label={t("crawlFrontier.console.labels.totalScoreDelta")}>
                      {formatNumber(traceSummary.totalScoreDelta)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("crawlFrontier.console.labels.totalFreshnessDelta")}>
                      {formatNumber(traceSummary.totalFreshnessDelta)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("crawlFrontier.console.labels.changedFields")} span={2}>
                      <Space wrap>
                        {traceSummary.changedFields.map((field) => (
                          <Tag key={`changed-${field}`}>{field}</Tag>
                        ))}
                        {traceSummary.changedFields.length === 0 ? "-" : null}
                      </Space>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("crawlFrontier.console.labels.ruleHits")} span={2}>
                      <Space wrap>
                        {traceSummary.ruleHits.map((rule) => (
                          <Tag key={`rule-${rule}`}>
                            {rule}
                          </Tag>
                        ))}
                        {traceSummary.ruleHits.length === 0 ? "-" : null}
                      </Space>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("crawlFrontier.console.labels.stepChain")} span={2}>
                      <Space wrap size={[4, 4]}>
                        {traceChain.map((step) => (
                          <Tag
                            key={step.key}
                            color={
                              step.status === "selected"
                                ? "success"
                                : step.status === "rejected"
                                  ? "error"
                                  : undefined
                            }
                          >
                            {`${step.index}. ${step.label}`}
                          </Tag>
                        ))}
                      </Space>
                    </Descriptions.Item>
                  </Descriptions>
                );
              })()}
            </Card>
            <Card size="small" title={t("crawlFrontier.console.workflowCandidate.trace")}>
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                {buildWorkflowCandidateTraceChain(selectedWorkflowCandidate).map((step) => {
                  const entry = step.entry;
                  const diffRows = buildWorkflowTraceEntryDiffRows(entry);
                  return (
                  <div key={step.key} className="surface-inset">
                    <Space direction="vertical" size={8} style={{ width: "100%" }}>
                      <Space wrap size={[6, 6]}>
                        <Tag>{entry.nodeType}</Tag>
                        <Tag
                          color={
                            step.status === "selected"
                              ? "success"
                              : step.status === "rejected"
                                ? "error"
                                : undefined
                          }
                        >
                          {entry.action}
                        </Tag>
                        {step.rejectedReason ? (
                          <Tag>{step.rejectedReason}</Tag>
                        ) : null}
                        <Typography.Text type="secondary">
                          {formatDateTime(entry.timestamp)}
                        </Typography.Text>
                      </Space>
                      <Typography.Text>{entry.message}</Typography.Text>
                      {step.deltaSummary.length > 0 ? (
                        <Space wrap size={[4, 4]}>
                          {step.deltaSummary.map((delta) => (
                            <Tag key={`${step.key}-${delta}`}>
                              {delta}
                            </Tag>
                          ))}
                        </Space>
                      ) : null}
                      {step.changedFields.length > 0 ? (
                        <Space wrap size={[4, 4]}>
                          {step.changedFields.map((field) => (
                            <Tag key={`${step.key}-${field}`}>{field}</Tag>
                          ))}
                        </Space>
                      ) : null}
                      {diffRows.length > 0 ? (
                        <Descriptions size="small" column={1} bordered>
                          {diffRows.map((diff) => (
                            <Descriptions.Item key={`${step.key}-${diff.field}`} label={diff.field}>
                              <Space direction="vertical" size={2} style={{ width: "100%" }}>
                                <Typography.Text type="secondary">
                                  {`before: ${diff.beforeValue}`}
                                </Typography.Text>
                                <Typography.Text>{`after: ${diff.afterValue}`}</Typography.Text>
                              </Space>
                            </Descriptions.Item>
                          ))}
                        </Descriptions>
                      ) : null}
                      {entry.ruleHits?.length ? (
                        <Space wrap size={[4, 4]}>
                          {entry.ruleHits.map((rule) => (
                            <Tag key={`${entry.nodeId}-${rule}`}>
                              {rule}
                            </Tag>
                          ))}
                        </Space>
                      ) : null}
                      <Collapse
                        size="small"
                        ghost
                        items={[
                          {
                            key: `${step.key}-snapshots`,
                            label: t("crawlFrontier.console.workflowCandidate.rawSnapshots"),
                            children: (
                              <Row gutter={[12, 12]}>
                                <Col xs={24} md={12}>
                                  <div className="hairline-b pb-3">
                                    <div className="kicker mb-1">{t("crawlFrontier.console.workflowCandidate.before")}</div>
                                    <Typography.Paragraph
                                      className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}
                                    >
                                      {stringifyJson(entry.beforeSnapshot ?? {})}
                                    </Typography.Paragraph>
                                  </div>
                                </Col>
                                <Col xs={24} md={12}>
                                  <div className="hairline-b pb-3">
                                    <div className="kicker mb-1">{t("crawlFrontier.console.workflowCandidate.after")}</div>
                                    <Typography.Paragraph
                                      className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}
                                    >
                                      {stringifyJson(entry.afterSnapshot ?? {})}
                                    </Typography.Paragraph>
                                  </div>
                                </Col>
                              </Row>
                            ),
                          },
                        ]}
                      />
                      {entry.details ? (
                        <Typography.Paragraph
                          className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}
                            >
                              {stringifyJson(entry.details)}
                            </Typography.Paragraph>
                          ) : null}
                        </Space>
                      </div>
                )})}
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>

      <Drawer title={t("crawlFrontier.console.nodeDrawer.title")} open={nodeDrawerOpen} onClose={() => { setNodeDrawerOpen(false); setSelectedNode(null); }} width="min(980px, 100vw)">
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
                  {asString(asRecord(selectedNode.metadata)?.failureKind) ? <Tag color="error">{String(asRecord(selectedNode.metadata)?.failureKind)}</Tag> : null}
                  {asStringArray(asRecord(selectedNode.metadata)?.warningFlags).map((flag) => <Tag key={`node-${flag}`} color="warning">{flag}</Tag>)}
                </Space>
                <Typography.Text>{selectedNode.url}</Typography.Text>
                <Typography.Text type="secondary">discovery: {formatPath(selectedNode.metadata?.discoveryPath)} · frontier: {formatPath(selectedNode.metadata?.frontierPath)}</Typography.Text>
              </Space>
            </Card>
            <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.basics")}>
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label={t("crawlFrontier.console.labels.canonicalURL")}>{selectedNode.canonicalUrl ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.depth")}>{selectedNode.depth}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.attempts")}>{selectedNode.attempts}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.parentNode")}>{selectedNode.parentNodeId ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.discoveredAt")}>{formatDateTime(selectedNode.discoveredAt)}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.crawledAt")}>{formatDateTime(selectedNode.crawledAt)}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.clusterLabel")}>{asString(asRecord(selectedNode.metadata)?.clusterLabel) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.seedOrigin")}>{asString(asRecord(selectedNode.metadata)?.seedOrigin) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.seedMethod")}>{asString(asRecord(selectedNode.metadata)?.seedMethod) ?? "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.judgment")}>
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label={t("crawlFrontier.console.labels.score")}>{formatNumber(selectedNode.score)}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.freshness")}>{formatNumber(selectedNode.freshnessScore)}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.judgeMethod")}>{asString(asRecord(selectedNode.metadata)?.judgeMethod) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.judgeConfidence")}>{formatNumber(asRecord(selectedNode.metadata)?.judgeConfidence)}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.judgeReason")}>{asString(asRecord(selectedNode.metadata)?.judgeReason) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.localeHint")}>{asString(asRecord(selectedNode.metadata)?.localeHint) ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.selectorHints")} span={2}><Space wrap>{asStringArray(asRecord(selectedNode.metadata)?.selectorHints).map((hint) => <Tag key={hint}>{hint}</Tag>)}{asStringArray(asRecord(selectedNode.metadata)?.selectorHints).length === 0 ? "-" : null}</Space></Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.rejectionReason")}>{selectedNode.rejectionReason ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.lastError")}>{selectedNode.lastError ?? "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.runLinkage")}>
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label={t("crawlFrontier.console.labels.run")}>{selectedNode.run.id}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.seedURL")}>{selectedNode.run.seedUrl}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.runStatus")}>{selectedNode.run.status}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.executionMode")}>{selectedNode.run.executionMode}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.profile")}>{selectedNode.run.profile?.name ?? "-"}</Descriptions.Item>
                <Descriptions.Item label={t("crawlFrontier.console.labels.profileHost")}>{selectedNode.run.profile?.matchHost ?? "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
            <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.crawlResult")}>
              {selectedNode.crawlResult ? <Descriptions size="small" column={2} bordered><Descriptions.Item label={t("crawlFrontier.console.labels.crawlResultID")}>{selectedNode.crawlResult.id}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.fetchedAt")}>{formatDateTime(selectedNode.crawlResult.fetchedAt)}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.sourceURL")}>{selectedNode.crawlResult.sourceUrl}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.markdownRef")}>{selectedNode.crawlResult.markdownRef}</Descriptions.Item></Descriptions> : <ChartEmptyState presentation="banner" description={t("crawlFrontier.console.nodeDrawer.empty.noCrawlResult")} />}
            </Card>
            <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.articleExtraction")}>
              {selectedNode.article || selectedNode.processedArticle ? (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  {selectedNode.article ? <Descriptions size="small" column={2} bordered><Descriptions.Item label={t("crawlFrontier.console.labels.articleURL")}>{selectedNode.article.url}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.crawlAt")}>{formatDateTime(selectedNode.article.crawlAt)}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.titleGuess")}>{selectedNode.article.titleGuess ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.sourceLabel")}>{selectedNode.article.sourceLabel ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.language")}>{selectedNode.article.language ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.repairApplied")}>{asRecord(selectedNode.article.llmRepair)?.applied === true ? "yes" : "no"}</Descriptions.Item></Descriptions> : null}
                  {selectedNode.processedArticle ? <Descriptions size="small" column={2} bordered><Descriptions.Item label={t("crawlFrontier.console.labels.processedTitle")}>{selectedNode.processedArticle.title ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.publishedAt")}>{formatDateTime(selectedNode.processedArticle.publishedAt)}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.author")}>{selectedNode.processedArticle.author ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.category")}>{selectedNode.processedArticle.category ?? "-"}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.qualityScore")}>{formatNumber(selectedNode.processedArticle.qualityScore)}</Descriptions.Item><Descriptions.Item label={t("crawlFrontier.console.labels.llmModel")}>{selectedNode.processedArticle.llmModel ?? "-"}</Descriptions.Item></Descriptions> : null}
                  {selectedNode.extractionSummary ? (
                    <div className="surface-inset">
                      <div className="kicker mb-2">{t("crawlFrontier.console.nodeDrawer.cards.extractionSummary")}</div>
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.processedStatus")}>{selectedNode.extractionSummary.processedStatus ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.qualityScore")}>{formatNumber(selectedNode.extractionSummary.qualityScore)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.extractedFields")} span={2}><Space wrap>{selectedNode.extractionSummary.extractedFields.map((field) => <Tag key={`extracted-${field}`}>{field}</Tag>)}{selectedNode.extractionSummary.extractedFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.missingFields")} span={2}><Space wrap>{selectedNode.extractionSummary.missingFields.map((field) => <Tag key={`missing-${field}`}>{field}</Tag>)}{selectedNode.extractionSummary.missingFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.removedNoise")} span={2}><Space wrap>{(selectedNode.extractionSummary.removedNoiseTypes ?? []).map((field) => <Tag key={`noise-${field}`}>{field}</Tag>)}{(selectedNode.extractionSummary.removedNoiseTypes ?? []).length === 0 ? "-" : null}</Space></Descriptions.Item>
                      </Descriptions>
                    </div>
                  ) : null}
                  {selectedNode.repairSummary ? (
                    <div className="surface-inset">
                      <div className="kicker mb-2">{t("crawlFrontier.console.nodeDrawer.cards.repairSummary")}</div>
                      <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.attempted")}>{selectedNode.repairSummary.attempted ? "yes" : "no"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.applied")}>{selectedNode.repairSummary.applied ? "yes" : "no"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.model")}>{selectedNode.repairSummary.model ?? "-"}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.latency")}>{formatNumber(selectedNode.repairSummary.latencyMs, 0)}</Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.missingFields")} span={2}><Space wrap>{selectedNode.repairSummary.missingFields.map((field) => <Tag key={`repair-missing-${field}`}>{field}</Tag>)}{selectedNode.repairSummary.missingFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.repairedFields")} span={2}><Space wrap>{selectedNode.repairSummary.repairedFields.map((field) => <Tag key={`repair-applied-${field}`}>{field}</Tag>)}{selectedNode.repairSummary.repairedFields.length === 0 ? "-" : null}</Space></Descriptions.Item>
                        <Descriptions.Item label={t("crawlFrontier.console.labels.error")} span={2}>{selectedNode.repairSummary.error ?? "-"}</Descriptions.Item>
                      </Descriptions>
                    </div>
                  ) : null}
                  {selectedNode.article?.llmRepair ? <Collapse items={[{ key: "repair", label: "Repair diagnostics JSON", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(selectedNode.article.llmRepair)}</Typography.Paragraph> }]} /> : null}
                </Space>
              ) : <ChartEmptyState presentation="banner" description={t("crawlFrontier.console.nodeDrawer.empty.noArticle")} />}
            </Card>
            {canViewLogLinks &&
            (selectedNode.llmLogFilters?.judge ||
              selectedNode.llmLogFilters?.learn ||
              selectedNode.llmLogFilters?.repair) ? (
              <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.relatedLlmLogs")}>
                <Space wrap>
                  {selectedNode.llmLogFilters?.judge ? <Button href={buildLlmLogsHref(selectedNode.llmLogFilters.judge)}>Judge logs</Button> : null}
                  {selectedNode.llmLogFilters?.learn ? <Button href={buildLlmLogsHref(selectedNode.llmLogFilters.learn)}>Learn logs</Button> : null}
                  {selectedNode.llmLogFilters?.repair ? <Button href={buildLlmLogsHref(selectedNode.llmLogFilters.repair)}>Repair logs</Button> : null}
                </Space>
              </Card>
            ) : null}
            <Card size="small" title={t("crawlFrontier.console.nodeDrawer.cards.metadata")}>
              <Collapse items={[
                { key: "nodeMetadata", label: "Node metadata JSON", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(selectedNode.metadata)}</Typography.Paragraph> },
                { key: "articleMetadata", label: "Article metadata JSON", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(selectedNode.article?.metadata)}</Typography.Paragraph> },
                { key: "crawlResultMetadata", label: "Crawl result metadata JSON", children: <Typography.Paragraph className="!mb-0 font-mono" style={{ whiteSpace: "pre-wrap" }}>{stringifyJson(selectedNode.crawlResult?.metadata)}</Typography.Paragraph> },
              ]} />
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
