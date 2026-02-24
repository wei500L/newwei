"use client";

import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, AutoComplete, Button, Input, Space, Spin, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

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
  upserts: Array<{ sourceId: string; key: string; value: string }>;
  removes: Array<{ sourceId: string; key: string }>;
}

interface NewsAggregatorMetadataResponse {
  sources?: Record<string, unknown>;
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
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();

  const [settings, setSettings] = useState<RuntimeSecretsResponse>(EMPTY_SETTINGS);
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [removed, setRemoved] = useState<Array<{ sourceId: string; key: string }>>([]);
  const [sourceSuggestions, setSourceSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const rowCounterRef = useRef(0);

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
        const sourceIds = Object.keys(metadataResponse.data?.sources ?? {}).sort((a, b) => a.localeCompare(b));
        setSourceSuggestions(sourceIds);
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
      messageApi.error(detail);
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const sourceOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...sourceSuggestions,
          ...rows.map((row) => normalizeSourceId(row.sourceId)).filter((value) => value.length > 0)
        ])
      )
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value })),
    [rows, sourceSuggestions]
  );

  const updateRow = useCallback((rowKey: string, patch: Partial<SecretRow>) => {
    setRows((prev) => prev.map((row) => (row.rowKey === rowKey ? { ...row, ...patch } : row)));
  }, []);

  const handleAddRow = useCallback(() => {
    setRows((prev) => [...prev, createDraftRow()]);
  }, [createDraftRow]);

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
        render: (_value, record) => (
          <AutoComplete
            value={record.sourceId}
            options={sourceOptions}
            onChange={(nextValue) => updateRow(record.rowKey, { sourceId: String(nextValue ?? "") })}
            placeholder={t("systemSettings.newsSourceRuntimeSecrets.placeholders.sourceId")}
            style={{ width: "100%" }}
            disabled={record.persisted}
          />
        )
      },
      {
        title: t("systemSettings.newsSourceRuntimeSecrets.fields.key"),
        dataIndex: "key",
        key: "key",
        width: 220,
        render: (_value, record) => (
          <Input
            value={record.key}
            onChange={(event) => updateRow(record.rowKey, { key: event.target.value })}
            placeholder={t("systemSettings.newsSourceRuntimeSecrets.placeholders.key")}
            disabled={record.persisted}
          />
        )
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
    [handleRemoveRow, sourceOptions, t, updateRow]
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
          {removed.length > 0 ? (
            <Tag color="orange">
              {t("systemSettings.newsSourceRuntimeSecrets.status.pendingRemoves", { count: removed.length })}
            </Tag>
          ) : null}
        </Space>
      </Space>

      <Space style={{ marginBottom: "1rem" }}>
        <Button icon={<PlusOutlined />} onClick={handleAddRow}>
          {t("systemSettings.newsSourceRuntimeSecrets.actions.addRow")}
        </Button>
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          {t("common.saveChanges")}
        </Button>
      </Space>

      <Table<SecretRow>
        rowKey="rowKey"
        columns={columns}
        dataSource={rows}
        pagination={false}
        size="small"
        locale={{ emptyText: t("systemSettings.newsSourceRuntimeSecrets.empty") }}
      />
    </>
  );
}
