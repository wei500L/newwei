"use client";

import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, AutoComplete, Button, Collapse, Empty, Input, Space, Spin, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import {
  filterRuntimeSecretSources,
  findExistingRuntimeSecretRow,
  getPrimaryRuntimeSecretKey,
  getRuntimeSecretEnvFallbackKeys,
  getRuntimeSecretRequirementLevel,
  getRuntimeSecretSuggestedKeys,
  listConfiguredRuntimeSecretSourceIds,
  matchesRuntimeSecretRowQuery,
  matchesRuntimeSecretSourceQuery,
  sourceSupportsRuntimeSecrets,
  type NewsSourceRuntimeSecretsConfig,
} from '@/lib/news-source-runtime-secrets';
import {
  resolveExpandedRuntimeSecretSourceIds,
  resolveRuntimeSecretDeepLinkAction,
} from '@/lib/news-source-runtime-secrets-ui';

type RuntimeSecretsSource = "none" | "db";

interface RuntimeSecretPublicEntry {
  sourceId: string;
  key: string;
  hasValue: boolean;
  fingerprint: string;
  updatedAt: string;
}

interface RuntimeSecretsResponse {
  source: RuntimeSecretsSource;
  entries: RuntimeSecretPublicEntry[];
}

interface RuntimeSecretsUpdatePayload {
  upserts: { sourceId: string; key: string; value: string }[];
  removes: { sourceId: string; key: string }[];
}

interface NewsAggregatorSourceMetadata {
  name?: string;
  runtimeSecrets?: NewsSourceRuntimeSecretsConfig;
}

interface NewsAggregatorMetadataResponse {
  sources?: Record<string, NewsAggregatorSourceMetadata>;
}

interface SecretRow {
  rowKey: string;
  sourceId: string;
  key: string;
  value: string;
  persisted: boolean;
  fingerprint: string | null;
  updatedAt: string | null;
}

const EMPTY_SETTINGS: RuntimeSecretsResponse = {
  source: "none",
  entries: []
};

const SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i;
const SECRET_KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const MAX_SECRET_VALUE_LENGTH = 8192;
const UNASSIGNED_SOURCE_GROUP_KEY = '__draft__';

const ERROR_CODE_I18N_KEY: Record<string, string> = {
  NEWS_SOURCE_RUNTIME_SECRETS_INVALID:
    "systemSettings.newsSourceRuntimeSecrets.errors.codes.NEWS_SOURCE_RUNTIME_SECRETS_INVALID"
};

function normalizeSourceId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSecretKey(value: string): string {
  return value.trim();
}

function makeCompositeKey(sourceId: string, key: string): string {
  return `${sourceId}::${key}`;
}

function formatApiError(
  error: unknown,
  fallback: string,
  t: (key: string, options?: { defaultValue?: string }) => string
): string {
  const parsed = extractApiError(error);
  const normalizedCode = parsed.code?.trim();
  const key = normalizedCode ? ERROR_CODE_I18N_KEY[normalizedCode] : undefined;
  const message =
    key !== undefined
      ? t(key, { defaultValue: parsed.message?.trim() || fallback })
      : parsed.message?.trim() || fallback;
  const detail = parsed.detail?.trim();
  if (!detail || detail === message) {
    return message;
  }
  return `${message} (${detail})`;
}

function toRows(entries: RuntimeSecretPublicEntry[]): SecretRow[] {
  return entries.map((entry) => ({
    rowKey: `persisted:${makeCompositeKey(entry.sourceId, entry.key)}`,
    sourceId: entry.sourceId,
    key: entry.key,
    value: "",
    persisted: true,
    fingerprint: entry.fingerprint || null,
    updatedAt: entry.updatedAt || null
  }));
}

export function NewsSourceRuntimeSecretsPanel() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();

  const [settings, setSettings] = useState<RuntimeSecretsResponse>(EMPTY_SETTINGS);
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [removed, setRemoved] = useState<{ sourceId: string; key: string }[]>([]);
  const [sourceCatalog, setSourceCatalog] = useState<Record<string, NewsAggregatorSourceMetadata>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | null>(null);
  const [showOnlyConfiguredSources, setShowOnlyConfiguredSources] = useState(
    () => searchParams.get('configuredOnly') === '1',
  );
  const [showOnlyRequiredSources, setShowOnlyRequiredSources] = useState(
    () => searchParams.get('requiredOnly') === '1',
  );
  const [sourceQuery, setSourceQuery] = useState(() => searchParams.get('sourceId')?.trim() ?? '');
  const [expandedSourceIds, setExpandedSourceIds] = useState<string[]>([]);

  const rowCounterRef = useRef(0);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const handledDeepLinkSourceIdRef = useRef<string | null>(null);
  const expandedSourceIdsInitializedRef = useRef(false);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const createDraftRow = useCallback((): SecretRow => {
    rowCounterRef.current += 1;
    return {
      rowKey: `draft:${rowCounterRef.current}`,
      sourceId: "",
      key: "",
      value: "",
      persisted: false,
      fingerprint: null,
      updatedAt: null
    };
  }, []);

  const createPrefilledDraftRow = useCallback(
    (sourceId: string, secretKey?: string): SecretRow => {
      const row = createDraftRow();
      return {
        ...row,
        sourceId,
        key: secretKey ?? '',
      };
    },
    [createDraftRow],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const settingsResponse = await apiClient.get<RuntimeSecretsResponse>(
        "system-settings/news-source-runtime-secrets"
      );
      const data: RuntimeSecretsResponse = {
        ...EMPTY_SETTINGS,
        ...(settingsResponse.data ?? {})
      };
      setSettings(data);
      setRows(toRows(data.entries));
      setRemoved([]);

      try {
        const metadataResponse = await apiClient.get<NewsAggregatorMetadataResponse>("news-aggregator/metadata");
        setSourceCatalog(metadataResponse.data?.sources ?? {});
      } catch (metadataError) {
        captureClientError("Failed to load news-aggregator metadata for runtime secrets panel", metadataError);
      }
    } catch (error) {
      captureClientError("Failed to load news source runtime secrets settings", error);
      const detail = formatApiError(
        error,
        t("systemSettings.newsSourceRuntimeSecrets.errors.loadFailed"),
        t
      );
      setErrorMessage(detail);
      setSettings(EMPTY_SETTINGS);
      setRows([]);
      setRemoved([]);
      setSourceCatalog({});
      messageApi.error(detail);
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const nextSourceId = searchParams.get('sourceId')?.trim() ?? '';
    setSourceQuery((current) => (current === nextSourceId ? current : nextSourceId));
    setShowOnlyConfiguredSources(searchParams.get('configuredOnly') === '1');
    setShowOnlyRequiredSources(searchParams.get('requiredOnly') === '1');
  }, [searchParams]);

  const filteredSourceEntries = useMemo(
    () =>
      filterRuntimeSecretSources(
        Object.entries(sourceCatalog).map(([sourceId, metadata]) => ({ sourceId, metadata })),
        rows,
        {
          onlyConfigured: showOnlyConfiguredSources,
          onlyRequired: showOnlyRequiredSources,
        },
      ).filter((entry) => matchesRuntimeSecretSourceQuery(entry, sourceQuery)),
    [rows, showOnlyConfiguredSources, showOnlyRequiredSources, sourceCatalog, sourceQuery],
  );

  const configuredSourceIds = useMemo(
    () => new Set(listConfiguredRuntimeSecretSourceIds(rows)),
    [rows],
  );

  const sourceOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...filteredSourceEntries.map(({ sourceId }) => sourceId),
          ...rows.map((row) => normalizeSourceId(row.sourceId)).filter((value) => value.length > 0)
        ])
      )
        .sort((a, b) => a.localeCompare(b))
        .map((value) => {
          const sourceMetadata = sourceCatalog[value];
          const supportedKeys = getRuntimeSecretSuggestedKeys(sourceMetadata?.runtimeSecrets);
          return {
            value,
            label: sourceMetadata?.name
              ? `${sourceMetadata.name} (${value})${supportedKeys.length > 0 ? ` · ${supportedKeys.join(', ')}` : ''}`
              : value,
          };
        }),
    [filteredSourceEntries, rows, sourceCatalog]
  );

  const quickAddSources = useMemo(
    () =>
      filteredSourceEntries
        .map(({ sourceId, metadata }) => [sourceId, metadata] as const)
        .sort(([leftId, leftMeta], [rightId, rightMeta]) => {
          const leftName = leftMeta.name?.trim() || leftId;
          const rightName = rightMeta.name?.trim() || rightId;
          return leftName.localeCompare(rightName);
        }),
    [filteredSourceEntries],
  );

  const quickAddSections = useMemo(
    () => [
      {
        level: 'required' as const,
        title: t('systemSettings.newsSourceRuntimeSecrets.sections.required'),
        sources: quickAddSources.filter(
          ([, metadata]) => getRuntimeSecretRequirementLevel(metadata) === 'required',
        ),
      },
      {
        level: 'optional' as const,
        title: t('systemSettings.newsSourceRuntimeSecrets.sections.optional'),
        sources: quickAddSources.filter(
          ([, metadata]) => getRuntimeSecretRequirementLevel(metadata) === 'optional',
        ),
      },
    ].filter((section) => section.sources.length > 0),
    [quickAddSources, t],
  );

  const activeSourceMetadata = useMemo(
    () => sourceCatalog[normalizeSourceId(sourceQuery)],
    [sourceCatalog, sourceQuery],
  );

  const hasViewFilters = Boolean(
    sourceQuery.trim() || showOnlyConfiguredSources || showOnlyRequiredSources,
  );

  const keyOptionsBySourceId = useMemo(() => {
    return Object.fromEntries(
      Object.entries(sourceCatalog).map(([sourceId, metadata]) => [
        sourceId,
        getRuntimeSecretSuggestedKeys(metadata.runtimeSecrets).map((value) => ({ value })),
      ]),
    ) as Record<string, { value: string }[]>;
  }, [sourceCatalog]);

  const updateRow = useCallback((rowKey: string, patch: Partial<SecretRow>) => {
    setRows((prev) => prev.map((row) => (row.rowKey === rowKey ? { ...row, ...patch } : row)));
  }, []);

  const focusRow = useCallback(
    (rowKey: string, sourceId?: string) => {
      const normalizedSourceId = normalizeSourceId(sourceId ?? '');
      const groupKey = normalizedSourceId || UNASSIGNED_SOURCE_GROUP_KEY;
      setExpandedSourceIds((current) =>
        current.includes(groupKey) ? current : [...current, groupKey],
      );
      setHighlightedRowKey(rowKey);
      window.setTimeout(() => {
        setHighlightedRowKey((current) => (current === rowKey ? null : current));
      }, 2400);
      window.requestAnimationFrame(() => {
        const rowElement = tableContainerRef.current?.querySelector<HTMLElement>(
          `[data-row-key="${rowKey}"]`,
        );
        rowElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
    [],
  );

  const replaceViewStateQueryParams = useCallback(
    (input: {
      sourceId?: string;
      configuredOnly?: boolean;
      requiredOnly?: boolean;
    }) => {
      const next = new URLSearchParams(searchParams.toString());
      const nextSourceId = input.sourceId?.trim() ?? '';
      if (nextSourceId) {
        next.set('sourceId', nextSourceId);
      } else {
        next.delete('sourceId');
      }
      if (input.configuredOnly) {
        next.set('configuredOnly', '1');
      } else {
        next.delete('configuredOnly');
      }
      if (input.requiredOnly) {
        next.set('requiredOnly', '1');
      } else {
        next.delete('requiredOnly');
      }
      const nextQuery = next.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const handleAddRow = useCallback(() => {
    const nextRow = createDraftRow();
    setRows((prev) => [...prev, nextRow]);
    focusRow(nextRow.rowKey, nextRow.sourceId);
  }, [createDraftRow, focusRow]);

  const handleQuickAddSource = useCallback(
    (sourceId: string) => {
      setSourceQuery(sourceId);
      setShowOnlyConfiguredSources(false);
      setShowOnlyRequiredSources(false);
      replaceViewStateQueryParams({
        sourceId,
        configuredOnly: false,
        requiredOnly: false,
      });
      const sourceMetadata = sourceCatalog[sourceId];
      const preferredKey = getPrimaryRuntimeSecretKey(sourceMetadata?.runtimeSecrets);
      const existingRow = findExistingRuntimeSecretRow(rows, sourceId, preferredKey);
      if (existingRow) {
        focusRow(existingRow.rowKey, sourceId);
        messageApi.info(
          t('systemSettings.newsSourceRuntimeSecrets.messages.focusedExisting', {
            sourceId,
            key: existingRow.key || preferredKey || '-',
          }),
        );
        return;
      }
      const nextRow = createPrefilledDraftRow(sourceId, preferredKey);
      setRows((prev) => [...prev, nextRow]);
      focusRow(nextRow.rowKey, sourceId);
    },
    [createPrefilledDraftRow, focusRow, messageApi, replaceViewStateQueryParams, rows, sourceCatalog, t],
  );

  const resetViewFilters = useCallback(() => {
    setSourceQuery('');
    setShowOnlyConfiguredSources(false);
    setShowOnlyRequiredSources(false);
    replaceViewStateQueryParams({
      sourceId: '',
      configuredOnly: false,
      requiredOnly: false,
    });
  }, [replaceViewStateQueryParams]);

  useEffect(() => {
    const deepLinkedSourceId = searchParams.get('sourceId')?.trim();
    if (!deepLinkedSourceId) {
      handledDeepLinkSourceIdRef.current = null;
      return;
    }
    if (loading) {
      return;
    }
    setShowOnlyConfiguredSources(false);
    setShowOnlyRequiredSources(false);
    setSourceQuery(deepLinkedSourceId);

    const action = resolveRuntimeSecretDeepLinkAction(rows, sourceCatalog, deepLinkedSourceId);
    if (action.type === 'pending') {
      return;
    }
    if (handledDeepLinkSourceIdRef.current === deepLinkedSourceId) {
      return;
    }
    handledDeepLinkSourceIdRef.current = deepLinkedSourceId;

    if (action.type === 'focus') {
      focusRow(action.row.rowKey, deepLinkedSourceId);
      return;
    }

    if (action.type === 'ignore') {
      return;
    }

    const nextRow = createPrefilledDraftRow(action.sourceId, action.secretKey);
    setRows((prev) => [...prev, nextRow]);
    focusRow(nextRow.rowKey, action.sourceId);
  }, [createPrefilledDraftRow, focusRow, loading, rows, searchParams, sourceCatalog]);

  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        if (showOnlyConfiguredSources && !row.persisted) {
          return false;
        }

        if (showOnlyRequiredSources) {
          const sourceMetadata = sourceCatalog[normalizeSourceId(row.sourceId)];
          if (getRuntimeSecretRequirementLevel(sourceMetadata) !== 'required') {
            return false;
          }
        }

        const sourceMetadata = sourceCatalog[normalizeSourceId(row.sourceId)];
        return matchesRuntimeSecretRowQuery(row, sourceMetadata, sourceQuery);
      }),
    [rows, showOnlyConfiguredSources, showOnlyRequiredSources, sourceCatalog, sourceQuery],
  );

  const groupedVisibleRows = useMemo(() => {
    const groups = new Map<
      string,
      {
        groupKey: string;
        sourceId: string;
        metadata?: NewsAggregatorSourceMetadata;
        rows: SecretRow[];
        isDraftGroup: boolean;
      }
    >();

    visibleRows.forEach((row) => {
      const sourceId = normalizeSourceId(row.sourceId);
      const isDraftGroup = sourceId.length === 0;
      const groupKey = isDraftGroup ? UNASSIGNED_SOURCE_GROUP_KEY : sourceId;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.rows.push(row);
        return;
      }
      groups.set(groupKey, {
        groupKey,
        sourceId,
        metadata: sourceId ? sourceCatalog[sourceId] : undefined,
        rows: [row],
        isDraftGroup,
      });
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        totalCount: group.rows.length,
        persistedCount: group.rows.filter((row) => row.persisted).length,
        draftCount: group.rows.filter((row) => !row.persisted).length,
        requirementLevel: getRuntimeSecretRequirementLevel(group.metadata),
      }))
      .sort((left, right) => {
        if (left.isDraftGroup !== right.isDraftGroup) {
          return left.isDraftGroup ? -1 : 1;
        }
        const leftName = left.metadata?.name?.trim() || left.sourceId;
        const rightName = right.metadata?.name?.trim() || right.sourceId;
        return leftName.localeCompare(rightName);
      });
  }, [sourceCatalog, visibleRows]);

  useEffect(() => {
    const visibleSourceIds = groupedVisibleRows.map((group) => group.groupKey);
    setExpandedSourceIds((current) => {
      const result = resolveExpandedRuntimeSecretSourceIds({
        currentExpandedSourceIds: current,
        visibleSourceIds,
        sourceQuery,
        hasInitialized: expandedSourceIdsInitializedRef.current,
      });
      expandedSourceIdsInitializedRef.current = result.hasInitialized;
      return result.nextExpandedSourceIds;
    });
  }, [groupedVisibleRows, sourceQuery]);

  const handleRemoveRow = useCallback((row: SecretRow) => {
    setRows((prev) => prev.filter((item) => item.rowKey !== row.rowKey));
    if (!row.persisted) {
      return;
    }
    const sourceId = normalizeSourceId(row.sourceId);
    const key = normalizeSecretKey(row.key);
    if (!sourceId || !key) {
      return;
    }
    setRemoved((prev) => {
      const composite = makeCompositeKey(sourceId, key);
      if (prev.some((item) => makeCompositeKey(item.sourceId, item.key) === composite)) {
        return prev;
      }
      return [...prev, { sourceId, key }];
    });
  }, []);

  const buildPayload = useCallback((): RuntimeSecretsUpdatePayload | null => {
    const upsertsMap = new Map<string, { sourceId: string; key: string; value: string }>();
    const seenComposite = new Set<string>();

    for (const row of rows) {
      const sourceId = normalizeSourceId(row.sourceId);
      const key = normalizeSecretKey(row.key);
      const value = row.value.trim();

      const isEntirelyEmpty = !sourceId && !key && !value && !row.persisted;
      if (isEntirelyEmpty) {
        continue;
      }

      if (!sourceId) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.sourceIdRequired"));
        return null;
      }
      if (!SOURCE_ID_PATTERN.test(sourceId)) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.sourceIdPattern"));
        return null;
      }
      if (!key) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.keyRequired"));
        return null;
      }
      if (!SECRET_KEY_PATTERN.test(key) || key.length > 128) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.keyPattern"));
        return null;
      }

      const composite = makeCompositeKey(sourceId, key);
      if (seenComposite.has(composite)) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.duplicateEntry"));
        return null;
      }
      seenComposite.add(composite);

      if (!row.persisted && !value) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.valueRequiredForNew"));
        return null;
      }
      if (value && value.length > MAX_SECRET_VALUE_LENGTH) {
        messageApi.error(t("systemSettings.newsSourceRuntimeSecrets.validation.valueTooLong"));
        return null;
      }

      if (value) {
        upsertsMap.set(composite, { sourceId, key, value });
      }
    }

    const removesMap = new Map<string, { sourceId: string; key: string }>();
    for (const item of removed) {
      const sourceId = normalizeSourceId(item.sourceId);
      const key = normalizeSecretKey(item.key);
      if (!sourceId || !key) {
        continue;
      }
      removesMap.set(makeCompositeKey(sourceId, key), { sourceId, key });
    }

    for (const composite of upsertsMap.keys()) {
      removesMap.delete(composite);
    }

    return {
      upserts: [...upsertsMap.values()],
      removes: [...removesMap.values()]
    };
  }, [messageApi, removed, rows, t]);

  const handleSave = useCallback(async () => {
    const payload = buildPayload();
    if (!payload) {
      return;
    }
    if (payload.upserts.length === 0 && payload.removes.length === 0) {
      messageApi.info(t("systemSettings.newsSourceRuntimeSecrets.messages.noChanges"));
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.put<RuntimeSecretsResponse>(
        "system-settings/news-source-runtime-secrets",
        payload
      );
      const data: RuntimeSecretsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {})
      };
      setSettings(data);
      setRows(toRows(data.entries));
      setRemoved([]);
      messageApi.success(t("systemSettings.newsSourceRuntimeSecrets.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save news source runtime secrets settings", error);
      const detail = formatApiError(
        error,
        t("systemSettings.newsSourceRuntimeSecrets.errors.saveFailed"),
        t
      );
      setErrorMessage(detail);
      messageApi.error(detail);
    } finally {
      setSaving(false);
    }
  }, [apiClient, buildPayload, messageApi, t]);

  const columns = useMemo<ColumnsType<SecretRow>>(
    () => [
      {
        title: t("systemSettings.newsSourceRuntimeSecrets.fields.sourceId"),
        dataIndex: "sourceId",
        key: "sourceId",
        width: 210,
        render: (_value, record) => {
          const normalizedSourceId = normalizeSourceId(record.sourceId);
          const sourceMetadata = normalizedSourceId ? sourceCatalog[normalizedSourceId] : undefined;
          const supportedKeys = getRuntimeSecretSuggestedKeys(sourceMetadata?.runtimeSecrets);
          const envFallbackKeys = getRuntimeSecretEnvFallbackKeys(sourceMetadata?.runtimeSecrets);
          const sourceDescription = sourceMetadata?.runtimeSecrets?.description?.trim();
          return (
            <Space direction="vertical" size={2} style={{ display: "flex" }}>
              <AutoComplete
                value={record.sourceId}
                options={sourceOptions}
                onChange={(nextValue) => {
                  const nextSourceId = String(nextValue ?? '');
                  const normalizedNextSourceId = normalizeSourceId(nextSourceId);
                  const nextSourceMetadata = normalizedNextSourceId
                    ? sourceCatalog[normalizedNextSourceId]
                    : undefined;
                  const preferredKey = !record.key.trim()
                    ? getPrimaryRuntimeSecretKey(nextSourceMetadata?.runtimeSecrets)
                    : undefined;
                  updateRow(record.rowKey, {
                    sourceId: nextSourceId,
                    ...(preferredKey ? { key: preferredKey } : {}),
                  });
                }}
                placeholder={t("systemSettings.newsSourceRuntimeSecrets.placeholders.sourceId")}
                style={{ width: "100%" }}
                disabled={record.persisted}
              />
              {sourceMetadata?.name ? (
                <Typography.Text type="secondary">{sourceMetadata.name}</Typography.Text>
              ) : null}
              {!record.persisted ? (
                <Tag color="gold">
                  {t('systemSettings.newsSourceRuntimeSecrets.status.draft')}
                </Tag>
              ) : null}
              {sourceDescription ? (
                <Typography.Text type="secondary">{sourceDescription}</Typography.Text>
              ) : null}
              {supportedKeys.length > 0 ? (
                <Typography.Text type="secondary">
                  {t('systemSettings.newsSourceRuntimeSecrets.hints.suggestedKeys', {
                    keys: supportedKeys.join(', '),
                  })}
                </Typography.Text>
              ) : null}
              {envFallbackKeys.length > 0 ? (
                <Typography.Text type="secondary">
                  {t('systemSettings.newsSourceRuntimeSecrets.hints.envFallback', {
                    keys: envFallbackKeys.join(', '),
                  })}
                </Typography.Text>
              ) : null}
            </Space>
          );
        }
      },
      {
        title: t("systemSettings.newsSourceRuntimeSecrets.fields.key"),
        dataIndex: "key",
        key: "key",
        width: 220,
        render: (_value, record) => {
          const normalizedSourceId = normalizeSourceId(record.sourceId);
          const sourceMetadata = normalizedSourceId ? sourceCatalog[normalizedSourceId] : undefined;
          const keyOptions = keyOptionsBySourceId[normalizedSourceId] ?? [];
          const requiredAnyOfKeys = sourceMetadata?.runtimeSecrets?.requiredAnyOfKeys ?? [];

          return (
            <Space direction="vertical" size={2} style={{ display: "flex" }}>
              <AutoComplete
                value={record.key}
                options={keyOptions}
                onChange={(nextValue) => updateRow(record.rowKey, { key: String(nextValue ?? "") })}
                placeholder={t("systemSettings.newsSourceRuntimeSecrets.placeholders.key")}
                disabled={record.persisted}
                style={{ width: '100%' }}
                filterOption={(inputValue, option) =>
                  String(option?.value ?? '').toLowerCase().includes(inputValue.toLowerCase())
                }
              >
                <Input disabled={record.persisted} />
              </AutoComplete>
              {requiredAnyOfKeys.length > 0 ? (
                <Typography.Text type="secondary">
                  {t('systemSettings.newsSourceRuntimeSecrets.hints.requiredAnyOf', {
                    keys: requiredAnyOfKeys.join(', '),
                  })}
                </Typography.Text>
              ) : sourceSupportsRuntimeSecrets(sourceMetadata) ? (
                <Typography.Text type="secondary">
                  {t('systemSettings.newsSourceRuntimeSecrets.hints.optionalOverride')}
                </Typography.Text>
              ) : null}
            </Space>
          );
        }
      },
      {
        title: t("systemSettings.newsSourceRuntimeSecrets.fields.value"),
        dataIndex: "value",
        key: "value",
        render: (_value, record) => (
          <Input.Password
            value={record.value}
            onChange={(event) => updateRow(record.rowKey, { value: event.target.value })}
            placeholder={
              record.persisted
                ? t("systemSettings.newsSourceRuntimeSecrets.placeholders.keepExistingValue")
                : t("systemSettings.newsSourceRuntimeSecrets.placeholders.value")
            }
          />
        )
      },
      {
        title: t("systemSettings.newsSourceRuntimeSecrets.fields.fingerprint"),
        dataIndex: "fingerprint",
        key: "fingerprint",
        width: 180,
        render: (_value, record) =>
          record.fingerprint ? (
            <Tag color="blue">{record.fingerprint}</Tag>
          ) : (
            <Typography.Text type="secondary">
              {t("systemSettings.newsSourceRuntimeSecrets.status.notStored")}
            </Typography.Text>
          )
      },
      {
        title: t("systemSettings.newsSourceRuntimeSecrets.fields.updatedAt"),
        dataIndex: "updatedAt",
        key: "updatedAt",
        width: 220,
        render: (_value, record) => {
          if (!record.updatedAt) {
            return (
              <Typography.Text type="secondary">
                {t("systemSettings.newsSourceRuntimeSecrets.status.notStored")}
              </Typography.Text>
            );
          }
          const updatedAt = new Date(record.updatedAt);
          if (Number.isNaN(updatedAt.valueOf())) {
            return record.updatedAt;
          }
          return updatedAt.toLocaleString();
        }
      },
      {
        title: t("common.actions"),
        key: "actions",
        width: 90,
        align: "center",
        render: (_value, record) => (
          <Button
            danger
            type="text"
            icon={<DeleteOutlined />}
            aria-label={t("common.remove")}
            onClick={() => handleRemoveRow(record)}
          />
        )
      }
    ],
    [handleRemoveRow, keyOptionsBySourceId, sourceCatalog, sourceOptions, t, updateRow]
  );

  if (loading && rows.length === 0) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  const sourceColor = settings.source === "db" ? "green" : "default";
  const sourceLabel =
    settings.source === "db"
      ? t("systemSettings.newsSourceRuntimeSecrets.status.saved")
      : settings.source === "none"
        ? t("systemSettings.newsSourceRuntimeSecrets.status.default")
        : t("systemSettings.newsSourceRuntimeSecrets.status.unavailable");
  const emptyState = hasViewFilters ? (
    <Empty
      description={t('systemSettings.newsSourceRuntimeSecrets.emptyFiltered')}
    >
      <Button onClick={resetViewFilters}>
        {t('systemSettings.newsSourceRuntimeSecrets.filters.clear')}
      </Button>
    </Empty>
  ) : (
    t("systemSettings.newsSourceRuntimeSecrets.empty")
  );

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.newsSourceRuntimeSecrets.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.newsSourceRuntimeSecrets.notice.title")}
        description={t("systemSettings.newsSourceRuntimeSecrets.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.newsSourceRuntimeSecrets.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag>{t("systemSettings.newsSourceRuntimeSecrets.status.entryCount", { count: rows.length })}</Tag>
          {(showOnlyConfiguredSources || showOnlyRequiredSources) ? (
            <Tag color="blue">
              {t('systemSettings.newsSourceRuntimeSecrets.status.visibleCount', {
                count: visibleRows.length,
              })}
            </Tag>
          ) : null}
          {showOnlyConfiguredSources ? (
            <Tag color="geekblue">
              {t('systemSettings.newsSourceRuntimeSecrets.filters.onlyConfigured')}
            </Tag>
          ) : null}
          {showOnlyRequiredSources ? (
            <Tag color="purple">
              {t('systemSettings.newsSourceRuntimeSecrets.filters.onlyRequired')}
            </Tag>
          ) : null}
          {removed.length > 0 ? (
            <Tag color="orange">
              {t("systemSettings.newsSourceRuntimeSecrets.status.pendingRemoves", { count: removed.length })}
            </Tag>
          ) : null}
          {sourceQuery.trim() ? (
            <Tag color="cyan">
              {activeSourceMetadata?.name
                ? `${activeSourceMetadata.name} (${sourceQuery.trim()})`
                : sourceQuery.trim()}
            </Tag>
          ) : null}
        </Space>
        {activeSourceMetadata?.runtimeSecrets?.description ? (
          <Typography.Text type="secondary">
            {activeSourceMetadata.runtimeSecrets.description}
          </Typography.Text>
        ) : null}
      </Space>

      <Space style={{ marginBottom: "1rem" }}>
        <Button icon={<PlusOutlined />} onClick={handleAddRow}>
          {t("systemSettings.newsSourceRuntimeSecrets.actions.addRow")}
        </Button>
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          {t("common.saveChanges")}
        </Button>
      </Space>

      <Space wrap style={{ marginBottom: '1rem' }}>
        <Input.Search
          allowClear
          value={sourceQuery}
          onChange={(event) => {
            const nextValue = event.target.value;
            setSourceQuery(nextValue);
            if (!nextValue.trim()) {
              replaceViewStateQueryParams({
                sourceId: '',
                configuredOnly: showOnlyConfiguredSources,
                requiredOnly: showOnlyRequiredSources,
              });
            }
          }}
          onSearch={(value) => {
            setSourceQuery(value);
            replaceViewStateQueryParams({
              sourceId: value,
              configuredOnly: showOnlyConfiguredSources,
              requiredOnly: showOnlyRequiredSources,
            });
          }}
          placeholder={t('systemSettings.newsSourceRuntimeSecrets.filters.search')}
          style={{ width: 280 }}
        />
        {hasViewFilters ? (
          <Button onClick={resetViewFilters}>
            {t('systemSettings.newsSourceRuntimeSecrets.filters.clear')}
          </Button>
        ) : null}
        <Space size={6}>
          <Switch
            size="small"
            checked={showOnlyConfiguredSources}
            onChange={(checked) => {
              setShowOnlyConfiguredSources(checked);
              replaceViewStateQueryParams({
                sourceId: sourceQuery,
                configuredOnly: checked,
                requiredOnly: showOnlyRequiredSources,
              });
            }}
          />
          <Typography.Text>
            {t('systemSettings.newsSourceRuntimeSecrets.filters.onlyConfigured')}
          </Typography.Text>
        </Space>
        <Space size={6}>
          <Switch
            size="small"
            checked={showOnlyRequiredSources}
            onChange={(checked) => {
              setShowOnlyRequiredSources(checked);
              replaceViewStateQueryParams({
                sourceId: sourceQuery,
                configuredOnly: showOnlyConfiguredSources,
                requiredOnly: checked,
              });
            }}
          />
          <Typography.Text>
            {t('systemSettings.newsSourceRuntimeSecrets.filters.onlyRequired')}
          </Typography.Text>
        </Space>
      </Space>

      {quickAddSections.length > 0 ? (
        <Space direction="vertical" size="small" style={{ display: 'flex', marginBottom: '1rem' }}>
          <Typography.Text type="secondary">
            {t('systemSettings.newsSourceRuntimeSecrets.actions.quickAdd')}
          </Typography.Text>
          {quickAddSections.map((section) => (
            <Space key={section.level} direction="vertical" size={4} style={{ display: 'flex' }}>
              <Typography.Text type="secondary">{section.title}</Typography.Text>
              <Space wrap>
                {section.sources.map(([sourceId, metadata]) => {
                  const preferredKey = getPrimaryRuntimeSecretKey(metadata.runtimeSecrets);
                  const isConfigured = configuredSourceIds.has(normalizeSourceId(sourceId));
                  return (
                    <Space key={sourceId} size={4}>
                      <Button
                        size="small"
                        type={isConfigured ? 'primary' : 'default'}
                        onClick={() => handleQuickAddSource(sourceId)}
                      >
                        {metadata.name ?? sourceId}
                        {preferredKey ? ` · ${preferredKey}` : ''}
                      </Button>
                      {isConfigured ? (
                        <Tag color="green">
                          {t('systemSettings.newsSourceRuntimeSecrets.status.configured')}
                        </Tag>
                      ) : null}
                    </Space>
                  );
                })}
              </Space>
            </Space>
          ))}
        </Space>
      ) : null}

      <div ref={tableContainerRef}>
        {groupedVisibleRows.length > 0 ? (
          <Collapse
            activeKey={expandedSourceIds}
            onChange={(keys) => {
              const normalized = Array.isArray(keys) ? keys.map(String) : [String(keys)];
              setExpandedSourceIds(normalized.filter((key) => key.length > 0));
            }}
            items={groupedVisibleRows.map((group) => {
              const sourceName = group.isDraftGroup
                ? t('systemSettings.newsSourceRuntimeSecrets.groups.unassignedDrafts')
                : group.metadata?.name?.trim() || group.sourceId;
              const requirementColor =
                group.isDraftGroup
                  ? 'gold'
                  : group.requirementLevel === 'required'
                  ? 'red'
                  : group.requirementLevel === 'optional'
                    ? 'blue'
                    : 'default';
              const requirementLabel =
                group.isDraftGroup
                  ? t('systemSettings.newsSourceRuntimeSecrets.status.draft')
                  : group.requirementLevel === 'required'
                  ? t('systemSettings.newsSourceRuntimeSecrets.sections.required')
                  : group.requirementLevel === 'optional'
                    ? t('systemSettings.newsSourceRuntimeSecrets.sections.optional')
                    : t('systemSettings.newsSourceRuntimeSecrets.status.notStored');

              return {
                key: group.groupKey,
                label: (
                  <Space wrap>
                    <Typography.Text strong>{sourceName}</Typography.Text>
                    {!group.isDraftGroup ? (
                      <Typography.Text type="secondary">{group.sourceId}</Typography.Text>
                    ) : null}
                    <Tag color={requirementColor}>{requirementLabel}</Tag>
                    <Tag>
                      {t('systemSettings.newsSourceRuntimeSecrets.groups.totalCount', {
                        count: group.totalCount,
                      })}
                    </Tag>
                    <Tag color="green">
                      {t('systemSettings.newsSourceRuntimeSecrets.groups.persistedCount', {
                        count: group.persistedCount,
                      })}
                    </Tag>
                    {group.draftCount > 0 ? (
                      <Tag color="gold">
                        {t('systemSettings.newsSourceRuntimeSecrets.groups.draftCount', {
                          count: group.draftCount,
                        })}
                      </Tag>
                    ) : null}
                  </Space>
                ),
                children: (
                  <Table<SecretRow>
                    rowKey="rowKey"
                    columns={columns}
                    dataSource={group.rows}
                    pagination={false}
                    size="small"
                    rowClassName={(record) =>
                      record.rowKey === highlightedRowKey ? 'bg-amber-50 dark:!bg-amber-500/10' : ''
                    }
                    locale={{ emptyText: emptyState }}
                  />
                ),
              };
            })}
          />
        ) : (
          emptyState
        )}
      </div>
    </>
  );
}
