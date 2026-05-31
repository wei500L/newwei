"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Divider,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

interface NewsEventSourcePolicyDelta {
  authoritativeDomainsAdd: string[];
  authoritativeDomainsRemove: string[];
  authoritativeLabelsAdd: string[];
  authoritativeLabelsRemove: string[];
  blogDomainsAdd: string[];
  blogDomainsRemove: string[];
  blogLabelsAdd: string[];
  blogLabelsRemove: string[];
}

type NewsEventSourcePolicyRevisionOperation = "update" | "rollback" | "reset";

interface NewsEventSourcePolicyRevision {
  revision: number;
  operation: NewsEventSourcePolicyRevisionOperation;
  actorId?: string | null;
  createdAt: string;
  note?: string | null;
  delta: NewsEventSourcePolicyDelta;
}

interface NewsEventSourcePolicyModel {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
  activeRevision: number;
  updatedAt?: string | null;
  warnings: {
    domainConflicts: string[];
    labelConflicts: string[];
    hasConflicts: boolean;
  };
  overrides: NewsEventSourcePolicyDelta;
  revisions: NewsEventSourcePolicyRevision[];
  syncWarnings: string[];
}

interface QueryData {
  newsEventSourcePolicy: NewsEventSourcePolicyModel;
}

interface NewsEventSourcePolicyPresetModel {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
  updatedAt?: string | null;
  syncWarnings: string[];
}

interface PresetQueryData {
  newsEventSourcePolicyPresets: NewsEventSourcePolicyPresetModel;
}

interface NewsEventSourcePolicySyncStatusModel {
  degraded: boolean;
  warningCodes: string[];
}

interface SyncStatusQueryData {
  newsEventSourcePolicySyncStatus: NewsEventSourcePolicySyncStatusModel;
}

interface NewsEventSourcePolicyRevisionDiffModel {
  baseRevision: number;
  targetRevision: number;
  authoritativeDomainsAdd: string[];
  authoritativeDomainsRemove: string[];
  authoritativeLabelsAdd: string[];
  authoritativeLabelsRemove: string[];
  blogDomainsAdd: string[];
  blogDomainsRemove: string[];
  blogLabelsAdd: string[];
  blogLabelsRemove: string[];
}

interface RevisionDiffQueryData {
  newsEventSourcePolicyRevisionDiff: NewsEventSourcePolicyRevisionDiffModel;
}

interface MutationData {
  updateNewsEventSourcePolicy: NewsEventSourcePolicyModel;
}

interface UpdatePresetMutationData {
  updateNewsEventSourcePolicyPresets: NewsEventSourcePolicyPresetModel;
}

interface RollbackMutationData {
  rollbackNewsEventSourcePolicy: NewsEventSourcePolicyModel;
}

interface ResetMutationData {
  resetNewsEventSourcePolicy: NewsEventSourcePolicyModel;
}

interface FormValues {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
  note?: string;
}

interface PresetFormValues {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
  note?: string;
}

type SpacetimeTimelineSourceType =
  | "all"
  | "authoritative"
  | "mixed"
  | "blog";
type SpacetimeTimelineSortBy = "latest" | "heat" | "credibility";
type SpacetimeTimelineGranularity = "auto" | "day" | "week" | "month";

interface SpacetimeTimelineUiSettings {
  authoritativeLock: boolean;
  requireCorroborated: boolean;
  sourceType: SpacetimeTimelineSourceType;
  sortBy: SpacetimeTimelineSortBy;
  minHeatScore: number;
  minCredibilityScore: number;
  timelineGranularity: SpacetimeTimelineGranularity;
  speed: number;
  syncStatusAutoRefresh: boolean;
}

interface SpacetimeTimelineUiSettingsResponse {
  settings: SpacetimeTimelineUiSettings | null;
}

const NEWS_EVENT_SOURCE_POLICY_QUERY = gql`
  query NewsEventSourcePolicy {
    newsEventSourcePolicy {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
      activeRevision
      updatedAt
      warnings {
        domainConflicts
        labelConflicts
        hasConflicts
      }
      overrides {
        authoritativeDomainsAdd
        authoritativeDomainsRemove
        authoritativeLabelsAdd
        authoritativeLabelsRemove
        blogDomainsAdd
        blogDomainsRemove
        blogLabelsAdd
        blogLabelsRemove
      }
      revisions {
        revision
        operation
        actorId
        createdAt
        note
        delta {
          authoritativeDomainsAdd
          authoritativeDomainsRemove
          authoritativeLabelsAdd
          authoritativeLabelsRemove
          blogDomainsAdd
          blogDomainsRemove
          blogLabelsAdd
          blogLabelsRemove
        }
      }
      syncWarnings
    }
  }
`;

const UPDATE_NEWS_EVENT_SOURCE_POLICY_MUTATION = gql`
  mutation UpdateNewsEventSourcePolicy(
    $input: UpdateNewsEventSourcePolicyInput!
  ) {
    updateNewsEventSourcePolicy(input: $input) {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
      activeRevision
      updatedAt
      warnings {
        domainConflicts
        labelConflicts
        hasConflicts
      }
      overrides {
        authoritativeDomainsAdd
        authoritativeDomainsRemove
        authoritativeLabelsAdd
        authoritativeLabelsRemove
        blogDomainsAdd
        blogDomainsRemove
        blogLabelsAdd
        blogLabelsRemove
      }
      revisions {
        revision
        operation
        actorId
        createdAt
        note
        delta {
          authoritativeDomainsAdd
          authoritativeDomainsRemove
          authoritativeLabelsAdd
          authoritativeLabelsRemove
          blogDomainsAdd
          blogDomainsRemove
          blogLabelsAdd
          blogLabelsRemove
        }
      }
      syncWarnings
    }
  }
`;

const NEWS_EVENT_SOURCE_POLICY_PRESETS_QUERY = gql`
  query NewsEventSourcePolicyPresets {
    newsEventSourcePolicyPresets {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
      updatedAt
      syncWarnings
    }
  }
`;

const NEWS_EVENT_SOURCE_POLICY_SYNC_STATUS_QUERY = gql`
  query NewsEventSourcePolicySyncStatus {
    newsEventSourcePolicySyncStatus {
      degraded
      warningCodes
    }
  }
`;

const UPDATE_NEWS_EVENT_SOURCE_POLICY_PRESETS_MUTATION = gql`
  mutation UpdateNewsEventSourcePolicyPresets(
    $input: UpdateNewsEventSourcePolicyPresetInput!
  ) {
    updateNewsEventSourcePolicyPresets(input: $input) {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
      updatedAt
      syncWarnings
    }
  }
`;

const ROLLBACK_NEWS_EVENT_SOURCE_POLICY_MUTATION = gql`
  mutation RollbackNewsEventSourcePolicy(
    $input: RollbackNewsEventSourcePolicyInput!
  ) {
    rollbackNewsEventSourcePolicy(input: $input) {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
      activeRevision
      updatedAt
      warnings {
        domainConflicts
        labelConflicts
        hasConflicts
      }
      overrides {
        authoritativeDomainsAdd
        authoritativeDomainsRemove
        authoritativeLabelsAdd
        authoritativeLabelsRemove
        blogDomainsAdd
        blogDomainsRemove
        blogLabelsAdd
        blogLabelsRemove
      }
      revisions {
        revision
        operation
        actorId
        createdAt
        note
        delta {
          authoritativeDomainsAdd
          authoritativeDomainsRemove
          authoritativeLabelsAdd
          authoritativeLabelsRemove
          blogDomainsAdd
          blogDomainsRemove
          blogLabelsAdd
          blogLabelsRemove
        }
      }
      syncWarnings
    }
  }
`;

const RESET_NEWS_EVENT_SOURCE_POLICY_MUTATION = gql`
  mutation ResetNewsEventSourcePolicy(
    $input: ResetNewsEventSourcePolicyInput!
  ) {
    resetNewsEventSourcePolicy(input: $input) {
      authoritativeDomains
      authoritativeLabels
      blogDomains
      blogLabels
      activeRevision
      updatedAt
      warnings {
        domainConflicts
        labelConflicts
        hasConflicts
      }
      overrides {
        authoritativeDomainsAdd
        authoritativeDomainsRemove
        authoritativeLabelsAdd
        authoritativeLabelsRemove
        blogDomainsAdd
        blogDomainsRemove
        blogLabelsAdd
        blogLabelsRemove
      }
      revisions {
        revision
        operation
        actorId
        createdAt
        note
        delta {
          authoritativeDomainsAdd
          authoritativeDomainsRemove
          authoritativeLabelsAdd
          authoritativeLabelsRemove
          blogDomainsAdd
          blogDomainsRemove
          blogLabelsAdd
          blogLabelsRemove
        }
      }
      syncWarnings
    }
  }
`;

const NEWS_EVENT_SOURCE_POLICY_REVISION_DIFF_QUERY = gql`
  query NewsEventSourcePolicyRevisionDiff(
    $baseRevision: Int!
    $targetRevision: Int!
  ) {
    newsEventSourcePolicyRevisionDiff(
      baseRevision: $baseRevision
      targetRevision: $targetRevision
    ) {
      baseRevision
      targetRevision
      authoritativeDomainsAdd
      authoritativeDomainsRemove
      authoritativeLabelsAdd
      authoritativeLabelsRemove
      blogDomainsAdd
      blogDomainsRemove
      blogLabelsAdd
      blogLabelsRemove
    }
  }
`;

const TAG_TOKEN_SEPARATORS = [",", "\n", "\t"];
const NOTE_MAX_LENGTH = 500;
const STALE_POLICY_REVISION_ERROR = "stale source policy revision";
const STALE_POLICY_PRESET_ERROR = "stale source policy preset timestamp";
const SYNC_STATUS_POLL_INTERVAL_MS = 60_000;
const SPACETIME_TIMELINE_SETTINGS_SAVE_DEBOUNCE_MS = 650;
const SPACETIME_TIMELINE_SETTINGS_PATH = "user-settings/ui/spacetime-timeline";

const DEFAULT_SPACETIME_TIMELINE_SETTINGS: SpacetimeTimelineUiSettings = {
  authoritativeLock: true,
  requireCorroborated: true,
  sourceType: "authoritative",
  sortBy: "heat",
  minHeatScore: 0.7,
  minCredibilityScore: 48,
  timelineGranularity: "auto",
  speed: 2,
  syncStatusAutoRefresh: true,
} as const;

type TokenFieldName =
  | "authoritativeDomains"
  | "authoritativeLabels"
  | "blogDomains"
  | "blogLabels";

function normalizeTokenList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = values
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized)).slice(0, 1000);
}

function summarizeDelta(delta: NewsEventSourcePolicyDelta): {
  addCount: number;
  removeCount: number;
} {
  const addCount =
    delta.authoritativeDomainsAdd.length +
    delta.authoritativeLabelsAdd.length +
    delta.blogDomainsAdd.length +
    delta.blogLabelsAdd.length;

  const removeCount =
    delta.authoritativeDomainsRemove.length +
    delta.authoritativeLabelsRemove.length +
    delta.blogDomainsRemove.length +
    delta.blogLabelsRemove.length;

  return { addCount, removeCount };
}

function hasErrorKeyword(error: unknown, keyword: string): boolean {
  if (!keyword) {
    return false;
  }
  const loweredKeyword = keyword.toLowerCase();
  const walk = (value: unknown): boolean => {
    if (!value) {
      return false;
    }
    if (typeof value === "string") {
      return value.toLowerCase().includes(loweredKeyword);
    }
    if (Array.isArray(value)) {
      return value.some((entry) => walk(entry));
    }
    if (typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some((entry) =>
        walk(entry),
      );
    }
    return false;
  };
  return walk(error);
}

function normalizeWarningCodes(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped).slice(0, 32);
}

function normalizeSpacetimeTimelineSourceType(
  value: unknown,
): SpacetimeTimelineSourceType {
  if (
    value === "all" ||
    value === "authoritative" ||
    value === "mixed" ||
    value === "blog"
  ) {
    return value;
  }
  return DEFAULT_SPACETIME_TIMELINE_SETTINGS.sourceType;
}

function normalizeSpacetimeTimelineSortBy(
  value: unknown,
): SpacetimeTimelineSortBy {
  if (value === "latest" || value === "heat" || value === "credibility") {
    return value;
  }
  return DEFAULT_SPACETIME_TIMELINE_SETTINGS.sortBy;
}

function normalizeSpacetimeTimelineGranularity(
  value: unknown,
): SpacetimeTimelineGranularity {
  if (
    value === "auto" ||
    value === "day" ||
    value === "week" ||
    value === "month"
  ) {
    return value;
  }
  return DEFAULT_SPACETIME_TIMELINE_SETTINGS.timelineGranularity;
}

function clampFloat(value: unknown, min: number, max: number, fallback: number) {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (numeric < min) {
    return min;
  }
  if (numeric > max) {
    return max;
  }
  return numeric;
}

function normalizeSpacetimeTimelineUiSettings(
  value: unknown,
): SpacetimeTimelineUiSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SPACETIME_TIMELINE_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  return {
    authoritativeLock:
      typeof record.authoritativeLock === "boolean"
        ? record.authoritativeLock
        : DEFAULT_SPACETIME_TIMELINE_SETTINGS.authoritativeLock,
    requireCorroborated:
      typeof record.requireCorroborated === "boolean"
        ? record.requireCorroborated
        : DEFAULT_SPACETIME_TIMELINE_SETTINGS.requireCorroborated,
    sourceType: normalizeSpacetimeTimelineSourceType(record.sourceType),
    sortBy: normalizeSpacetimeTimelineSortBy(record.sortBy),
    minHeatScore: clampFloat(
      record.minHeatScore,
      0,
      12,
      DEFAULT_SPACETIME_TIMELINE_SETTINGS.minHeatScore,
    ),
    minCredibilityScore: clampFloat(
      record.minCredibilityScore,
      0,
      100,
      DEFAULT_SPACETIME_TIMELINE_SETTINGS.minCredibilityScore,
    ),
    timelineGranularity: normalizeSpacetimeTimelineGranularity(
      record.timelineGranularity,
    ),
    speed: clampFloat(record.speed, 0.25, 16, DEFAULT_SPACETIME_TIMELINE_SETTINGS.speed),
    syncStatusAutoRefresh:
      typeof record.syncStatusAutoRefresh === "boolean"
        ? record.syncStatusAutoRefresh
        : DEFAULT_SPACETIME_TIMELINE_SETTINGS.syncStatusAutoRefresh,
  };
}

export function NewsEventSourcePolicySettingsPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const [form] = Form.useForm<FormValues>();
  const [presetForm] = Form.useForm<PresetFormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const syncStatusSettingsHydratedRef = useRef(false);
  const syncStatusSettingsSnapshotRef = useRef<string | null>(null);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [targetRevision, setTargetRevision] = useState<number | null>(null);
  const [policyRuntimeSyncWarnings, setPolicyRuntimeSyncWarnings] = useState<
    string[]
  >([]);
  const [presetRuntimeSyncWarnings, setPresetRuntimeSyncWarnings] = useState<
    string[]
  >([]);
  const [syncStatusAutoRefresh, setSyncStatusAutoRefresh] = useState(true);
  const [syncStatusLastRefreshedAt, setSyncStatusLastRefreshedAt] = useState<
    string | null
  >(null);
  const syncStatusSettingsSnapshot = useMemo(
    () => JSON.stringify({ syncStatusAutoRefresh }),
    [syncStatusAutoRefresh],
  );

  const { data, loading, refetch, error } = useQuery<QueryData>(
    NEWS_EVENT_SOURCE_POLICY_QUERY,
    {
      fetchPolicy: "cache-and-network",
    },
  );
  const {
    data: presetData,
    loading: presetLoading,
    refetch: refetchPresets,
    error: presetError,
  } = useQuery<PresetQueryData>(NEWS_EVENT_SOURCE_POLICY_PRESETS_QUERY, {
    fetchPolicy: "cache-and-network",
  });
  const {
    data: syncStatusData,
    loading: syncStatusLoading,
    refetch: refetchSyncStatus,
  } = useQuery<SyncStatusQueryData>(
    NEWS_EVENT_SOURCE_POLICY_SYNC_STATUS_QUERY,
    {
      fetchPolicy: "cache-and-network",
      errorPolicy: "all",
      pollInterval: syncStatusAutoRefresh ? SYNC_STATUS_POLL_INTERVAL_MS : 0,
    },
  );
  const {
    data: diffData,
    loading: diffLoading,
    error: diffError,
  } = useQuery<RevisionDiffQueryData>(
    NEWS_EVENT_SOURCE_POLICY_REVISION_DIFF_QUERY,
    {
      variables: {
        baseRevision: baseRevision ?? 1,
        targetRevision: targetRevision ?? 1,
      },
      skip: baseRevision === null || targetRevision === null,
      fetchPolicy: "network-only",
    },
  );

  const [updatePolicy, { loading: saving }] = useMutation<MutationData>(
    UPDATE_NEWS_EVENT_SOURCE_POLICY_MUTATION,
  );
  const [updatePresets, { loading: presetSaving }] =
    useMutation<UpdatePresetMutationData>(
      UPDATE_NEWS_EVENT_SOURCE_POLICY_PRESETS_MUTATION,
    );
  const [rollbackPolicy, { loading: rollingBack }] =
    useMutation<RollbackMutationData>(
      ROLLBACK_NEWS_EVENT_SOURCE_POLICY_MUTATION,
    );
  const [resetPolicy, { loading: resetting }] = useMutation<ResetMutationData>(
    RESET_NEWS_EVENT_SOURCE_POLICY_MUTATION,
  );

  const handleRefreshSyncStatus = useCallback(() => {
    void refetchSyncStatus().catch((error: unknown) => {
      captureClientError(
        "Failed to refresh source policy sync status in settings panel",
        error,
      );
    });
  }, [refetchSyncStatus]);

  useEffect(() => {
    if (!syncStatusLoading && syncStatusData?.newsEventSourcePolicySyncStatus) {
      setSyncStatusLastRefreshedAt(new Date().toISOString());
    }
  }, [syncStatusData, syncStatusLoading]);

  useEffect(() => {
    if (
      sessionStatus !== "authenticated" ||
      syncStatusSettingsHydratedRef.current
    ) {
      return;
    }
    syncStatusSettingsHydratedRef.current = true;

    let cancelled = false;
    void apiClient
      .get<SpacetimeTimelineUiSettingsResponse>(SPACETIME_TIMELINE_SETTINGS_PATH)
      .then(({ data }) => {
        if (cancelled) {
          return;
        }
        const settings = normalizeSpacetimeTimelineUiSettings(data?.settings);
        setSyncStatusAutoRefresh(settings.syncStatusAutoRefresh);
        syncStatusSettingsSnapshotRef.current = JSON.stringify({
          syncStatusAutoRefresh: settings.syncStatusAutoRefresh,
        });
      })
      .catch((error: unknown) => {
        syncStatusSettingsSnapshotRef.current = JSON.stringify({
          syncStatusAutoRefresh:
            DEFAULT_SPACETIME_TIMELINE_SETTINGS.syncStatusAutoRefresh,
        });
        captureClientError(
          "Failed to load spacetime timeline UI settings for source policy panel",
          error,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, sessionStatus]);

  useEffect(() => {
    if (
      sessionStatus !== "authenticated" ||
      !syncStatusSettingsHydratedRef.current
    ) {
      return;
    }
    if (syncStatusSettingsSnapshotRef.current === null) {
      return;
    }
    if (syncStatusSettingsSnapshotRef.current === syncStatusSettingsSnapshot) {
      return;
    }

    const timer = window.setTimeout(() => {
      const persistSyncStatusAutoRefresh = async () => {
        const current = await apiClient.get<SpacetimeTimelineUiSettingsResponse>(
          SPACETIME_TIMELINE_SETTINGS_PATH,
        );
        const currentSettings = normalizeSpacetimeTimelineUiSettings(
          current.data?.settings,
        );
        if (currentSettings.syncStatusAutoRefresh === syncStatusAutoRefresh) {
          syncStatusSettingsSnapshotRef.current = syncStatusSettingsSnapshot;
          return;
        }

        const response = await apiClient.put<SpacetimeTimelineUiSettingsResponse>(
          SPACETIME_TIMELINE_SETTINGS_PATH,
          {
            settings: {
              ...currentSettings,
              syncStatusAutoRefresh,
            } satisfies SpacetimeTimelineUiSettings,
          },
        );
        const persistedSettings = normalizeSpacetimeTimelineUiSettings(
          response.data?.settings,
        );
        syncStatusSettingsSnapshotRef.current = JSON.stringify({
          syncStatusAutoRefresh: persistedSettings.syncStatusAutoRefresh,
        });
        if (
          persistedSettings.syncStatusAutoRefresh !== syncStatusAutoRefresh
        ) {
          setSyncStatusAutoRefresh(persistedSettings.syncStatusAutoRefresh);
        }
      };

      void persistSyncStatusAutoRefresh().catch((error: unknown) => {
        syncStatusSettingsSnapshotRef.current = syncStatusSettingsSnapshot;
        captureClientError(
          "Failed to persist source policy sync-status auto refresh setting",
          error,
        );
      });
    }, SPACETIME_TIMELINE_SETTINGS_SAVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    apiClient,
    sessionStatus,
    syncStatusAutoRefresh,
    syncStatusSettingsSnapshot,
  ]);

  useEffect(() => {
    if (data?.newsEventSourcePolicy) {
      form.setFieldsValue({
        authoritativeDomains: data.newsEventSourcePolicy.authoritativeDomains,
        authoritativeLabels: data.newsEventSourcePolicy.authoritativeLabels,
        blogDomains: data.newsEventSourcePolicy.blogDomains,
        blogLabels: data.newsEventSourcePolicy.blogLabels,
      });
    }
  }, [data?.newsEventSourcePolicy, form]);

  useEffect(() => {
    if (!presetData?.newsEventSourcePolicyPresets) {
      return;
    }
    const preset = presetData.newsEventSourcePolicyPresets;
    presetForm.setFieldsValue({
      authoritativeDomains: preset.authoritativeDomains,
      authoritativeLabels: preset.authoritativeLabels,
      blogDomains: preset.blogDomains,
      blogLabels: preset.blogLabels,
    });
  }, [presetData?.newsEventSourcePolicyPresets, presetForm]);

  const authoritativeDomainOptions = Form.useWatch(
    "authoritativeDomains",
    form,
  );
  const authoritativeLabelOptions = Form.useWatch("authoritativeLabels", form);
  const blogDomainOptions = Form.useWatch("blogDomains", form);
  const blogLabelOptions = Form.useWatch("blogLabels", form);
  const presetAuthoritativeDomainOptions = Form.useWatch(
    "authoritativeDomains",
    presetForm,
  );
  const presetAuthoritativeLabelOptions = Form.useWatch(
    "authoritativeLabels",
    presetForm,
  );
  const presetBlogDomainOptions = Form.useWatch("blogDomains", presetForm);
  const presetBlogLabelOptions = Form.useWatch("blogLabels", presetForm);

  const toOptions = useMemo(
    () => (values: unknown) =>
      normalizeTokenList(values).map((value) => ({ label: value, value })),
    [],
  );

  const currentPolicy = data?.newsEventSourcePolicy ?? null;
  const policyLoaded = Boolean(currentPolicy);
  const currentPresets = presetData?.newsEventSourcePolicyPresets ?? null;
  const currentSyncStatus = syncStatusData?.newsEventSourcePolicySyncStatus;
  const revisionDiff = diffData?.newsEventSourcePolicyRevisionDiff ?? null;
  const resolveSyncWarningMessage = (code: string) => {
    if (code === "CACHE_WRITE_FAILED") {
      return t("settings.newsEventSourcePolicy.syncWarnings.cacheWriteFailed");
    }
    return code;
  };
  const policySyncWarnings = useMemo(
    () =>
      normalizeWarningCodes([
        ...(currentPolicy?.syncWarnings ?? []),
        ...policyRuntimeSyncWarnings,
      ]),
    [currentPolicy?.syncWarnings, policyRuntimeSyncWarnings],
  );
  const presetSyncWarnings = useMemo(
    () =>
      normalizeWarningCodes([
        ...(currentPresets?.syncWarnings ?? []),
        ...presetRuntimeSyncWarnings,
      ]),
    [currentPresets?.syncWarnings, presetRuntimeSyncWarnings],
  );
  const degradedStatusWarningCodes = useMemo(
    () => normalizeWarningCodes(currentSyncStatus?.warningCodes),
    [currentSyncStatus?.warningCodes],
  );
  const degradedStatusCritical = degradedStatusWarningCodes.some((code) =>
    code.endsWith("_DB_READ_FAILED"),
  );
  const resolveDegradedStatusWarningMessage = (code: string) => {
    if (code === "POLICY_CACHE_STALE") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPolicyCacheStale",
      );
    }
    if (code === "PRESET_CACHE_STALE") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPresetCacheStale",
      );
    }
    if (code === "POLICY_CACHE_READ_FAILED") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPolicyCacheReadFailed",
      );
    }
    if (code === "PRESET_CACHE_READ_FAILED") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPresetCacheReadFailed",
      );
    }
    if (code === "POLICY_DB_READ_FAILED") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPolicyDbReadFailed",
      );
    }
    if (code === "PRESET_DB_READ_FAILED") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPresetDbReadFailed",
      );
    }
    if (code === "POLICY_CACHE_MISS") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPolicyCacheMiss",
      );
    }
    if (code === "PRESET_CACHE_MISS") {
      return t(
        "settings.newsEventSourcePolicy.degraded.reasonPresetCacheMiss",
      );
    }
    return t("settings.newsEventSourcePolicy.degraded.reasonUnknown", {
      code,
    });
  };
  const degradedStatusReasonsText = useMemo(
    () =>
      degradedStatusWarningCodes
        .map((code) => resolveDegradedStatusWarningMessage(code))
        .join(" | "),
    [degradedStatusWarningCodes, t],
  );
  const degradedStatusEnabled = Boolean(currentSyncStatus?.degraded);
  const operationLabelMap: Record<
    NewsEventSourcePolicyRevisionOperation,
    string
  > = {
    update: t("settings.newsEventSourcePolicy.history.operationUpdate"),
    rollback: t("settings.newsEventSourcePolicy.history.operationRollback"),
    reset: t("settings.newsEventSourcePolicy.history.operationReset"),
  };

  const conflictDescription = useMemo(() => {
    if (!currentPolicy?.warnings?.hasConflicts) {
      return null;
    }

    const conflictParts: string[] = [];
    if (currentPolicy.warnings.domainConflicts.length > 0) {
      conflictParts.push(
        t("settings.newsEventSourcePolicy.conflicts.domainList", {
          value: currentPolicy.warnings.domainConflicts.join(", "),
        }),
      );
    }
    if (currentPolicy.warnings.labelConflicts.length > 0) {
      conflictParts.push(
        t("settings.newsEventSourcePolicy.conflicts.labelList", {
          value: currentPolicy.warnings.labelConflicts.join(", "),
        }),
      );
    }

    return conflictParts.join(" | ");
  }, [currentPolicy, t]);

  useEffect(() => {
    const revisions = currentPolicy?.revisions ?? [];
    if (revisions.length === 0) {
      setBaseRevision(null);
      setTargetRevision(null);
      return;
    }

    const sorted = revisions
      .slice()
      .sort((a, b) => b.revision - a.revision)
      .map((entry) => entry.revision);
    const latest = sorted[0]!;
    const previous = sorted[1] ?? latest;

    if (targetRevision === null || !sorted.includes(targetRevision)) {
      setTargetRevision(latest);
    }
    if (baseRevision === null || !sorted.includes(baseRevision)) {
      setBaseRevision(previous);
    }
  }, [baseRevision, currentPolicy?.revisions, targetRevision]);

  const appendPreset = (field: TokenFieldName, entries: unknown) => {
    const current = normalizeTokenList(form.getFieldValue(field));
    const merged = normalizeTokenList([
      ...current,
      ...normalizeTokenList(entries),
    ]);
    form.setFieldValue(field, merged);
  };

  const handleSubmit = async (values: FormValues) => {
    if (!currentPolicy) {
      messageApi.error(
        t("settings.newsEventSourcePolicy.messages.saveBlockedBeforeLoad"),
      );
      return;
    }
    const note = typeof values.note === "string" ? values.note.trim() : "";
    const payload = {
      authoritativeDomains: normalizeTokenList(values.authoritativeDomains),
      authoritativeLabels: normalizeTokenList(values.authoritativeLabels),
      blogDomains: normalizeTokenList(values.blogDomains),
      blogLabels: normalizeTokenList(values.blogLabels),
      note: note || null,
      expectedRevision: currentPolicy.activeRevision,
    };

    try {
      const result = await updatePolicy({ variables: { input: payload } });
      const syncWarnings = normalizeWarningCodes(
        result.data?.updateNewsEventSourcePolicy?.syncWarnings,
      );
      setPolicyRuntimeSyncWarnings(syncWarnings);
      form.setFieldValue("note", "");
      await refetch();
      messageApi.success(
        t("settings.newsEventSourcePolicy.messages.saved"),
      );
      if (syncWarnings.length > 0) {
        messageApi.warning(
          t("settings.newsEventSourcePolicy.messages.savedWithWarnings"),
        );
      }
    } catch (err) {
      if (hasErrorKeyword(err, STALE_POLICY_REVISION_ERROR)) {
        await refetch();
        messageApi.warning(
          t("settings.newsEventSourcePolicy.messages.concurrentUpdate"),
        );
        return;
      }
      captureClientError("Failed to save news event source policy", err);
      messageApi.error(
        t("settings.newsEventSourcePolicy.messages.saveFailed"),
      );
    }
  };

  const handlePresetSubmit = async (values: PresetFormValues) => {
    const note = typeof values.note === "string" ? values.note.trim() : "";
    const payload = {
      authoritativeDomains: normalizeTokenList(values.authoritativeDomains),
      authoritativeLabels: normalizeTokenList(values.authoritativeLabels),
      blogDomains: normalizeTokenList(values.blogDomains),
      blogLabels: normalizeTokenList(values.blogLabels),
      note: note || null,
      expectedUpdatedAt: currentPresets?.updatedAt ?? null,
    };
    try {
      const result = await updatePresets({ variables: { input: payload } });
      const syncWarnings = normalizeWarningCodes(
        result.data?.updateNewsEventSourcePolicyPresets?.syncWarnings,
      );
      setPresetRuntimeSyncWarnings(syncWarnings);
      presetForm.setFieldValue("note", "");
      await refetchPresets();
      messageApi.success(
        t("settings.newsEventSourcePolicy.messages.presetsSaved"),
      );
      if (syncWarnings.length > 0) {
        messageApi.warning(
          t(
            "settings.newsEventSourcePolicy.messages.presetsSavedWithWarnings",
          ),
        );
      }
    } catch (err) {
      if (hasErrorKeyword(err, STALE_POLICY_PRESET_ERROR)) {
        await refetchPresets();
        messageApi.warning(
          t("settings.newsEventSourcePolicy.messages.concurrentPresetUpdate"),
        );
        return;
      }
      captureClientError(
        "Failed to save news event source policy presets",
        err,
      );
      messageApi.error(
        t("settings.newsEventSourcePolicy.messages.presetsSaveFailed"),
      );
    }
  };

  const handleRollback = (revision: number) => {
    let noteValue = "";
    Modal.confirm({
      title: t("settings.newsEventSourcePolicy.history.rollbackConfirmTitle"),
      content: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {t("settings.newsEventSourcePolicy.history.rollbackConfirmBody", {
              revision,
            })}
          </Typography.Text>
          <Input.TextArea
            maxLength={NOTE_MAX_LENGTH}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={t(
              "settings.newsEventSourcePolicy.history.notePlaceholder",
            )}
            onChange={(event) => {
              noteValue = event.target.value ?? "";
            }}
          />
        </Space>
      ),
      onOk: async () => {
        try {
          const result = await rollbackPolicy({
            variables: {
              input: {
                revision,
                note: noteValue.trim() || null,
                expectedRevision: currentPolicy?.activeRevision ?? 0,
              },
            },
          });
          const syncWarnings = normalizeWarningCodes(
            result.data?.rollbackNewsEventSourcePolicy?.syncWarnings,
          );
          setPolicyRuntimeSyncWarnings(syncWarnings);
          await refetch();
          messageApi.success(
            t("settings.newsEventSourcePolicy.messages.rollbackSaved"),
          );
          if (syncWarnings.length > 0) {
            messageApi.warning(
              t("settings.newsEventSourcePolicy.messages.savedWithWarnings"),
            );
          }
        } catch (err) {
          if (hasErrorKeyword(err, STALE_POLICY_REVISION_ERROR)) {
            await refetch();
            messageApi.warning(
              t("settings.newsEventSourcePolicy.messages.concurrentUpdate"),
            );
            return;
          }
          captureClientError(
            "Failed to rollback news event source policy",
            err,
          );
          messageApi.error(
            t("settings.newsEventSourcePolicy.messages.rollbackFailed"),
          );
        }
      },
    });
  };

  const handleReset = () => {
    if (!currentPolicy) {
      messageApi.error(
        t("settings.newsEventSourcePolicy.messages.saveBlockedBeforeLoad"),
      );
      return;
    }
    let noteValue = "";
    Modal.confirm({
      title: t("settings.newsEventSourcePolicy.history.resetConfirmTitle"),
      content: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {t("settings.newsEventSourcePolicy.history.resetConfirmBody")}
          </Typography.Text>
          <Input.TextArea
            maxLength={NOTE_MAX_LENGTH}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={t(
              "settings.newsEventSourcePolicy.history.notePlaceholder",
            )}
            onChange={(event) => {
              noteValue = event.target.value ?? "";
            }}
          />
        </Space>
      ),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await resetPolicy({
            variables: {
              input: {
                note: noteValue.trim() || null,
                expectedRevision: currentPolicy.activeRevision,
              },
            },
          });
          const syncWarnings = normalizeWarningCodes(
            result.data?.resetNewsEventSourcePolicy?.syncWarnings,
          );
          setPolicyRuntimeSyncWarnings(syncWarnings);
          await refetch();
          messageApi.success(
            t("settings.newsEventSourcePolicy.messages.resetSaved"),
          );
          if (syncWarnings.length > 0) {
            messageApi.warning(
              t("settings.newsEventSourcePolicy.messages.savedWithWarnings"),
            );
          }
        } catch (err) {
          if (hasErrorKeyword(err, STALE_POLICY_REVISION_ERROR)) {
            await refetch();
            messageApi.warning(
              t("settings.newsEventSourcePolicy.messages.concurrentUpdate"),
            );
            return;
          }
          captureClientError("Failed to reset news event source policy", err);
          messageApi.error(
            t("settings.newsEventSourcePolicy.messages.resetFailed"),
          );
        }
      },
    });
  };

  const revisionOptions = useMemo(
    () =>
      (currentPolicy?.revisions ?? [])
        .slice()
        .sort((a, b) => b.revision - a.revision)
        .map((entry) => ({
          value: entry.revision,
          label: t("settings.newsEventSourcePolicy.history.revisionLabel", {
            revision: entry.revision,
          }),
        })),
    [currentPolicy?.revisions, t],
  );

  const diffGroups = useMemo(() => {
    if (!revisionDiff) {
      return [];
    }
    return [
      {
        label: t(
          "settings.newsEventSourcePolicy.history.deltaAuthoritativeDomainsAdd",
        ),
        values: revisionDiff.authoritativeDomainsAdd,
        color: "blue" as const,
      },
      {
        label: t(
          "settings.newsEventSourcePolicy.history.deltaAuthoritativeDomainsRemove",
        ),
        values: revisionDiff.authoritativeDomainsRemove,
        color: "red" as const,
      },
      {
        label: t(
          "settings.newsEventSourcePolicy.history.deltaAuthoritativeLabelsAdd",
        ),
        values: revisionDiff.authoritativeLabelsAdd,
        color: "blue" as const,
      },
      {
        label: t(
          "settings.newsEventSourcePolicy.history.deltaAuthoritativeLabelsRemove",
        ),
        values: revisionDiff.authoritativeLabelsRemove,
        color: "red" as const,
      },
      {
        label: t("settings.newsEventSourcePolicy.history.deltaBlogDomainsAdd"),
        values: revisionDiff.blogDomainsAdd,
        color: "orange" as const,
      },
      {
        label: t(
          "settings.newsEventSourcePolicy.history.deltaBlogDomainsRemove",
        ),
        values: revisionDiff.blogDomainsRemove,
        color: "green" as const,
      },
      {
        label: t("settings.newsEventSourcePolicy.history.deltaBlogLabelsAdd"),
        values: revisionDiff.blogLabelsAdd,
        color: "orange" as const,
      },
      {
        label: t(
          "settings.newsEventSourcePolicy.history.deltaBlogLabelsRemove",
        ),
        values: revisionDiff.blogLabelsRemove,
        color: "green" as const,
      },
    ].filter((group) => group.values.length > 0);
  }, [revisionDiff, t]);

  const handleSwapDiffRevisions = () => {
    if (baseRevision === null || targetRevision === null) {
      return;
    }
    setBaseRevision(targetRevision);
    setTargetRevision(baseRevision);
  };

  if (loading && !data?.newsEventSourcePolicy) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <Space size={8}>
          <Switch
            size="small"
            checked={syncStatusAutoRefresh}
            onChange={setSyncStatusAutoRefresh}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("settings.newsEventSourcePolicy.degraded.autoRefresh", {
              seconds: Math.round(SYNC_STATUS_POLL_INTERVAL_MS / 1000),
            })}
          </Typography.Text>
          <Button
            size="small"
            onClick={handleRefreshSyncStatus}
            loading={syncStatusLoading}
          >
            {t("settings.newsEventSourcePolicy.degraded.refreshStatus")}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {syncStatusLastRefreshedAt
              ? t("settings.newsEventSourcePolicy.degraded.lastRefreshAt", {
                  time:
                    formatDateTime(syncStatusLastRefreshedAt, locale, {
                      year: "2-digit",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZoneName: "short",
                    }) || "--",
                })
              : t("settings.newsEventSourcePolicy.degraded.lastRefreshNever")}
          </Typography.Text>
        </Space>
        {degradedStatusEnabled ? (
          <Tooltip
            title={t("settings.newsEventSourcePolicy.degraded.tooltip", {
              reasons:
                degradedStatusReasonsText ||
                t(
                  "settings.newsEventSourcePolicy.degraded.reasonUnknownShort",
                ),
            })}
          >
            <Tag
              color={degradedStatusCritical ? "error" : "warning"}
              style={{ marginInlineEnd: 0 }}
            >
              {t("settings.newsEventSourcePolicy.degraded.badge")}
            </Tag>
          </Tooltip>
        ) : null}
      </div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("settings.newsEventSourcePolicy.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsEventSourcePolicy.notice.title")}
        description={t("settings.newsEventSourcePolicy.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {currentPolicy ? (
        <Alert
          type="success"
          showIcon
          message={t("settings.newsEventSourcePolicy.history.activeRevision", {
            revision: currentPolicy.activeRevision,
          })}
          description={
            currentPolicy.updatedAt
              ? t("settings.newsEventSourcePolicy.history.updatedAt", {
                  value: dayjs(currentPolicy.updatedAt).format(
                    "YYYY-MM-DD HH:mm:ss",
                  ),
                })
              : undefined
          }
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {conflictDescription ? (
        <Alert
          type="warning"
          showIcon
          message={t("settings.newsEventSourcePolicy.conflicts.title")}
          description={conflictDescription}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {policySyncWarnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t("settings.newsEventSourcePolicy.syncWarnings.title")}
          description={policySyncWarnings
            .map((code) => resolveSyncWarningMessage(code))
            .join(" | ")}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsEventSourcePolicy.messages.loadFailed")}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t("settings.newsEventSourcePolicy.presets.quickApplyTitle")}
          description={
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text type="secondary">
                {t("settings.newsEventSourcePolicy.presets.quickApplyHint")}
              </Typography.Text>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() =>
                    appendPreset(
                      "authoritativeDomains",
                      currentPresets?.authoritativeDomains ?? [],
                    )
                  }
                  disabled={
                    presetLoading ||
                    (currentPresets?.authoritativeDomains.length ?? 0) === 0
                  }
                >
                  {t(
                    "settings.newsEventSourcePolicy.presets.authoritativeDomains",
                  )}
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    appendPreset(
                      "authoritativeLabels",
                      currentPresets?.authoritativeLabels ?? [],
                    )
                  }
                  disabled={
                    presetLoading ||
                    (currentPresets?.authoritativeLabels.length ?? 0) === 0
                  }
                >
                  {t(
                    "settings.newsEventSourcePolicy.presets.authoritativeLabels",
                  )}
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    appendPreset(
                      "blogDomains",
                      currentPresets?.blogDomains ?? [],
                    )
                  }
                  disabled={
                    presetLoading ||
                    (currentPresets?.blogDomains.length ?? 0) === 0
                  }
                >
                  {t("settings.newsEventSourcePolicy.presets.blogDomains")}
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    appendPreset("blogLabels", currentPresets?.blogLabels ?? [])
                  }
                  disabled={
                    presetLoading ||
                    (currentPresets?.blogLabels.length ?? 0) === 0
                  }
                >
                  {t("settings.newsEventSourcePolicy.presets.blogLabels")}
                </Button>
              </Space>
            </Space>
          }
        />

        <Form.Item
          label={t(
            "settings.newsEventSourcePolicy.fields.authoritativeDomains",
          )}
          name="authoritativeDomains"
          extra={t(
            "settings.newsEventSourcePolicy.hints.authoritativeDomains",
          )}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(authoritativeDomainOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.authoritativeDomains",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t(
            "settings.newsEventSourcePolicy.fields.authoritativeLabels",
          )}
          name="authoritativeLabels"
          extra={t("settings.newsEventSourcePolicy.hints.authoritativeLabels")}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(authoritativeLabelOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.authoritativeLabels",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.blogDomains")}
          name="blogDomains"
          extra={t("settings.newsEventSourcePolicy.hints.blogDomains")}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(blogDomainOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.blogDomains",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.blogLabels")}
          name="blogLabels"
          extra={t("settings.newsEventSourcePolicy.hints.blogLabels")}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(blogLabelOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.blogLabels",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.note")}
          name="note"
          extra={t("settings.newsEventSourcePolicy.hints.note")}
        >
          <Input.TextArea
            maxLength={NOTE_MAX_LENGTH}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={t("settings.newsEventSourcePolicy.placeholders.note")}
          />
        </Form.Item>

        <Space>
          <Button
            type="primary"
            htmlType="submit"
            loading={saving}
            disabled={loading || !policyLoaded}
          >
            {t("common.saveChanges")}
          </Button>
          <Button onClick={() => void refetch()}>
            {t("common.refresh")}
          </Button>
          <Button
            danger
            onClick={handleReset}
            loading={resetting}
            disabled={loading || !policyLoaded}
          >
            {t("settings.newsEventSourcePolicy.actions.resetDefaults")}
          </Button>
        </Space>
      </Form>

      <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
        {t("settings.newsEventSourcePolicy.presets.title")}
      </Typography.Title>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: "0.75rem" }}
      >
        {t("settings.newsEventSourcePolicy.presets.description")}
      </Typography.Paragraph>

      {presetError ? (
        <Alert
          type="error"
          showIcon
          message={t(
            "settings.newsEventSourcePolicy.messages.presetsLoadFailed",
          )}
          description={presetError.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {presetSyncWarnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t("settings.newsEventSourcePolicy.syncWarnings.title")}
          description={presetSyncWarnings
            .map((code) => resolveSyncWarningMessage(code))
            .join(" | ")}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {currentPresets?.updatedAt ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t("settings.newsEventSourcePolicy.presets.updatedAt", {
            value: dayjs(currentPresets.updatedAt).format(
              "YYYY-MM-DD HH:mm:ss",
            ),
          })}
        />
      ) : null}

      <Form layout="vertical" form={presetForm} onFinish={handlePresetSubmit}>
        <Form.Item
          label={t(
            "settings.newsEventSourcePolicy.fields.authoritativeDomains",
          )}
          name="authoritativeDomains"
          extra={t(
            "settings.newsEventSourcePolicy.hints.authoritativeDomains",
          )}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(presetAuthoritativeDomainOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.authoritativeDomains",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t(
            "settings.newsEventSourcePolicy.fields.authoritativeLabels",
          )}
          name="authoritativeLabels"
          extra={t("settings.newsEventSourcePolicy.hints.authoritativeLabels")}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(presetAuthoritativeLabelOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.authoritativeLabels",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.blogDomains")}
          name="blogDomains"
          extra={t("settings.newsEventSourcePolicy.hints.blogDomains")}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(presetBlogDomainOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.blogDomains",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.blogLabels")}
          name="blogLabels"
          extra={t("settings.newsEventSourcePolicy.hints.blogLabels")}
        >
          <Select
            mode="tags"
            tokenSeparators={TAG_TOKEN_SEPARATORS}
            options={toOptions(presetBlogLabelOptions)}
            placeholder={t(
              "settings.newsEventSourcePolicy.placeholders.blogLabels",
            )}
          />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEventSourcePolicy.fields.note")}
          name="note"
          extra={t("settings.newsEventSourcePolicy.hints.note")}
        >
          <Input.TextArea
            maxLength={NOTE_MAX_LENGTH}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={t("settings.newsEventSourcePolicy.placeholders.note")}
          />
        </Form.Item>

        <Space>
          <Button
            type="primary"
            htmlType="submit"
            loading={presetSaving}
            disabled={presetLoading}
          >
            {t("settings.newsEventSourcePolicy.actions.savePresets")}
          </Button>
          <Button onClick={() => void refetchPresets()} loading={presetLoading}>
            {t("common.refresh")}
          </Button>
        </Space>
      </Form>

      <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
        {t("settings.newsEventSourcePolicy.history.title")}
      </Typography.Title>

      <List
        size="small"
        bordered
        dataSource={currentPolicy?.revisions ?? []}
        locale={{
          emptyText: t("settings.newsEventSourcePolicy.history.empty"),
        }}
        renderItem={(entry) => {
          const { addCount, removeCount } = summarizeDelta(entry.delta);
          const isActive = entry.revision === currentPolicy?.activeRevision;
          const deltaGroups = [
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaAuthoritativeDomainsAdd",
              ),
              values: entry.delta.authoritativeDomainsAdd,
              color: "blue" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaAuthoritativeDomainsRemove",
              ),
              values: entry.delta.authoritativeDomainsRemove,
              color: "red" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaAuthoritativeLabelsAdd",
              ),
              values: entry.delta.authoritativeLabelsAdd,
              color: "blue" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaAuthoritativeLabelsRemove",
              ),
              values: entry.delta.authoritativeLabelsRemove,
              color: "red" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaBlogDomainsAdd",
              ),
              values: entry.delta.blogDomainsAdd,
              color: "orange" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaBlogDomainsRemove",
              ),
              values: entry.delta.blogDomainsRemove,
              color: "green" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaBlogLabelsAdd",
              ),
              values: entry.delta.blogLabelsAdd,
              color: "orange" as const,
            },
            {
              label: t(
                "settings.newsEventSourcePolicy.history.deltaBlogLabelsRemove",
              ),
              values: entry.delta.blogLabelsRemove,
              color: "green" as const,
            },
          ].filter((group) => group.values.length > 0);

          return (
            <List.Item
              key={entry.revision}
              actions={
                isActive
                  ? [
                      <Tag color="green" key="active">
                        {t("settings.newsEventSourcePolicy.history.activeTag")}
                      </Tag>,
                    ]
                  : [
                      <Button
                        key="rollback"
                        size="small"
                        onClick={() => handleRollback(entry.revision)}
                        loading={rollingBack}
                      >
                        {t(
                          "settings.newsEventSourcePolicy.history.rollbackAction",
                        )}
                      </Button>,
                    ]
              }
            >
              <List.Item.Meta
                title={
                  <Space wrap size="small">
                    <Typography.Text strong>
                      {t(
                        "settings.newsEventSourcePolicy.history.revisionLabel",
                        {
                          revision: entry.revision,
                        },
                      )}
                    </Typography.Text>
                    <Tag color="blue">{operationLabelMap[entry.operation]}</Tag>
                    <Typography.Text type="secondary">
                      {dayjs(entry.createdAt).format("YYYY-MM-DD HH:mm:ss")}
                    </Typography.Text>
                    {entry.actorId ? (
                      <Typography.Text type="secondary">
                        {t("settings.newsEventSourcePolicy.history.actor", {
                          value: entry.actorId,
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t(
                        "settings.newsEventSourcePolicy.history.deltaSummary",
                        {
                          adds: addCount,
                          removes: removeCount,
                        },
                      )}
                    </Typography.Text>
                    {entry.note ? (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {t("settings.newsEventSourcePolicy.history.note", {
                          note: entry.note,
                        })}
                      </Typography.Text>
                    ) : null}
                    {deltaGroups.length > 0 ? (
                      <>
                        <Divider style={{ margin: "6px 0" }} />
                        {deltaGroups.map((group) => {
                          const values = group.values.slice(0, 8);
                          const remaining = Math.max(
                            0,
                            group.values.length - values.length,
                          );

                          return (
                            <Space
                              key={`${entry.revision}-${group.label}`}
                              direction="vertical"
                              size={2}
                            >
                              <Typography.Text
                                type="secondary"
                                style={{ fontSize: 12 }}
                              >
                                {group.label}
                              </Typography.Text>
                              <Space wrap size={[4, 4]}>
                                {values.map((value) => (
                                  <Tag color={group.color} key={value}>
                                    {value}
                                  </Tag>
                                ))}
                                {remaining > 0 ? (
                                  <Tag>
                                    {t(
                                      "settings.newsEventSourcePolicy.history.moreItems",
                                      {
                                        count: remaining,
                                      },
                                    )}
                                  </Tag>
                                ) : null}
                              </Space>
                            </Space>
                          );
                        })}
                      </>
                    ) : null}
                  </Space>
                }
              />
            </List.Item>
          );
        }}
      />

      <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
        {t("settings.newsEventSourcePolicy.history.diffTitle")}
      </Typography.Title>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: "0.75rem" }}
      >
        {t("settings.newsEventSourcePolicy.history.diffDescription")}
      </Typography.Paragraph>

      <Space wrap size={[8, 8]} style={{ marginBottom: "0.75rem" }}>
        <Select
          style={{ minWidth: 180 }}
          value={baseRevision ?? undefined}
          options={revisionOptions}
          onChange={(value) => setBaseRevision(value)}
          placeholder={t("settings.newsEventSourcePolicy.history.diffBase")}
        />
        <Select
          style={{ minWidth: 180 }}
          value={targetRevision ?? undefined}
          options={revisionOptions}
          onChange={(value) => setTargetRevision(value)}
          placeholder={t("settings.newsEventSourcePolicy.history.diffTarget")}
        />
        <Button onClick={handleSwapDiffRevisions}>
          {t("settings.newsEventSourcePolicy.history.diffSwap")}
        </Button>
      </Space>

      {diffError ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsEventSourcePolicy.history.diffLoadFailed")}
          description={diffError.message}
          style={{ marginBottom: "0.75rem" }}
        />
      ) : null}

      {diffLoading ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "1rem 0",
          }}
        >
          <Spin />
        </div>
      ) : diffGroups.length > 0 ? (
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          {diffGroups.map((group) => {
            const values = group.values.slice(0, 20);
            const remaining = Math.max(0, group.values.length - values.length);

            return (
              <Space key={`diff-${group.label}`} direction="vertical" size={4}>
                <Typography.Text type="secondary">
                  {group.label}
                </Typography.Text>
                <Space wrap size={[4, 4]}>
                  {values.map((value) => (
                    <Tag color={group.color} key={`${group.label}-${value}`}>
                      {value}
                    </Tag>
                  ))}
                  {remaining > 0 ? (
                    <Tag>
                      {t("settings.newsEventSourcePolicy.history.moreItems", {
                        count: remaining,
                      })}
                    </Tag>
                  ) : null}
                </Space>
              </Space>
            );
          })}
        </Space>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("settings.newsEventSourcePolicy.history.diffEmpty")}
        />
      )}
    </>
  );
}
