"use client";

import { Alert, Button, Form, InputNumber, Select, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type NewsSourceSchedulerSettingsSource = "default" | "db";

interface NewsSourceSchedulerSettingsResponse {
  source: NewsSourceSchedulerSettingsSource;
  seedFreshnessWindowDays: number;
  seedCacheTtlSecondsSitemapRss: number;
  seedCacheTtlSecondsListDeep: number;
  seedCacheTtlForceGlobal: boolean;
  seedUrlQueryParamAllowlist: string[];
}

interface NewsSourceSchedulerSettingsFormValues {
  seedFreshnessWindowDays: number;
  seedCacheTtlSecondsSitemapRss: number;
  seedCacheTtlSecondsListDeep: number;
  seedCacheTtlForceGlobal: boolean;
  seedUrlQueryParamAllowlist: string[];
}

const DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST = [
  "id",
  "story",
  "article",
  "post",
  "item",
  "p",
  "page",
  "v",
  "ver",
  "lang",
  "locale",
  "hl",
];

const QUERY_PARAM_KEY_PATTERN = /^[a-z0-9_.-]{1,64}$/;

const normalizeQueryAllowlist = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const key = entry.trim().toLowerCase();
    if (!QUERY_PARAM_KEY_PATTERN.test(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
    if (normalized.length >= 64) {
      break;
    }
  }
  return normalized;
};

const resolveAllowlist = (value: unknown): string[] => {
  const normalized = normalizeQueryAllowlist(value);
  if (Array.isArray(value)) {
    return normalized;
  }
  return normalized.length > 0
    ? normalized
    : [...DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST];
};

const DEFAULT_SETTINGS: NewsSourceSchedulerSettingsResponse = {
  source: "default",
  seedFreshnessWindowDays: 365,
  seedCacheTtlSecondsSitemapRss: 60,
  seedCacheTtlSecondsListDeep: 180,
  seedCacheTtlForceGlobal: false,
  seedUrlQueryParamAllowlist: [...DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST],
};

const ERROR_CODE_I18N_KEY: Record<string, string> = {
  NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID:
    "systemSettings.newsSourceScheduler.errors.codes.NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID",
};

function formatApiError(
  error: unknown,
  fallback: string,
  t: (key: string, options?: { defaultValue?: string }) => string,
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

export function NewsSourceSchedulerSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<NewsSourceSchedulerSettingsFormValues>();
  const [settings, setSettings] = useState<NewsSourceSchedulerSettingsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const watchedSeedCacheTtlForceGlobal = Form.useWatch(
    "seedCacheTtlForceGlobal",
    form,
  );
  const watchedSeedCacheTtlSecondsSitemapRss = Form.useWatch(
    "seedCacheTtlSecondsSitemapRss",
    form,
  );
  const watchedSeedCacheTtlSecondsListDeep = Form.useWatch(
    "seedCacheTtlSecondsListDeep",
    form,
  );

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<NewsSourceSchedulerSettingsResponse>(
        "system-settings/news-source-scheduler",
      );
      const data: NewsSourceSchedulerSettingsResponse = {
        ...DEFAULT_SETTINGS,
        ...(response.data ?? {}),
        seedUrlQueryParamAllowlist: resolveAllowlist(
          response.data?.seedUrlQueryParamAllowlist,
        ),
      };
      setSettings(data);
      form.setFieldsValue({
        seedFreshnessWindowDays: data.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss: data.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: data.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: data.seedCacheTtlForceGlobal,
        seedUrlQueryParamAllowlist: data.seedUrlQueryParamAllowlist,
      });
    } catch (error) {
      captureClientError("Failed to load news source scheduler settings", error);
      const detail = formatApiError(
        error,
        t("systemSettings.newsSourceScheduler.errors.loadFailed"),
        t,
      );
      setErrorMessage(detail);
      setSettings(null);
      form.setFieldsValue({
        seedFreshnessWindowDays: DEFAULT_SETTINGS.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss:
          DEFAULT_SETTINGS.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: DEFAULT_SETTINGS.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: DEFAULT_SETTINGS.seedCacheTtlForceGlobal,
        seedUrlQueryParamAllowlist:
          DEFAULT_SETTINGS.seedUrlQueryParamAllowlist,
      });
      messageApi.error(detail);
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, messageApi, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (
    values: NewsSourceSchedulerSettingsFormValues,
  ) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload = {
        seedFreshnessWindowDays: values.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss: values.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: values.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: values.seedCacheTtlForceGlobal,
        seedUrlQueryParamAllowlist: normalizeQueryAllowlist(
          values.seedUrlQueryParamAllowlist,
        ),
      };
      const response = await apiClient.put<NewsSourceSchedulerSettingsResponse>(
        "system-settings/news-source-scheduler",
        payload,
      );
      const data: NewsSourceSchedulerSettingsResponse = {
        ...DEFAULT_SETTINGS,
        ...(response.data ?? {}),
        seedUrlQueryParamAllowlist: resolveAllowlist(
          response.data?.seedUrlQueryParamAllowlist,
        ),
      };
      setSettings(data);
      form.setFieldsValue({
        seedFreshnessWindowDays: data.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss: data.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: data.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: data.seedCacheTtlForceGlobal,
        seedUrlQueryParamAllowlist: data.seedUrlQueryParamAllowlist,
      });
      messageApi.success(t("systemSettings.newsSourceScheduler.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save news source scheduler settings", error);
      const detail = formatApiError(
        error,
        t("systemSettings.newsSourceScheduler.errors.saveFailed"),
        t,
      );
      setErrorMessage(detail);
      messageApi.error(detail);
    } finally {
      setSaving(false);
    }
  };

  if (loading && settings === null) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  const sourceColor = settings?.source === "db" ? "green" : "default";
  const sourceLabel =
    settings?.source === "db"
      ? t("systemSettings.newsSourceScheduler.status.saved")
      : settings?.source === "default"
        ? t("systemSettings.newsSourceScheduler.status.default")
        : t("systemSettings.newsSourceScheduler.status.unavailable");
  const isGlobalForced =
    typeof watchedSeedCacheTtlForceGlobal === "boolean"
      ? watchedSeedCacheTtlForceGlobal
      : (settings?.seedCacheTtlForceGlobal ?? false);
  const previewSeedCacheTtlSecondsSitemapRss =
    typeof watchedSeedCacheTtlSecondsSitemapRss === "number"
      ? watchedSeedCacheTtlSecondsSitemapRss
      : (settings?.seedCacheTtlSecondsSitemapRss ??
        DEFAULT_SETTINGS.seedCacheTtlSecondsSitemapRss);
  const previewSeedCacheTtlSecondsListDeep =
    typeof watchedSeedCacheTtlSecondsListDeep === "number"
      ? watchedSeedCacheTtlSecondsListDeep
      : (settings?.seedCacheTtlSecondsListDeep ??
        DEFAULT_SETTINGS.seedCacheTtlSecondsListDeep);

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.newsSourceScheduler.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.newsSourceScheduler.notice.title")}
        description={t("systemSettings.newsSourceScheduler.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.newsSourceScheduler.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color={isGlobalForced ? "gold" : "blue"}>
            {isGlobalForced
              ? t("systemSettings.newsSourceScheduler.policyPreview.globalForcedTag")
              : t("systemSettings.newsSourceScheduler.policyPreview.sourceAwareTag")}
          </Tag>
        </Space>
      </Space>

      <Alert
        type={isGlobalForced ? "warning" : "info"}
        showIcon
        message={
          isGlobalForced
            ? t("systemSettings.newsSourceScheduler.policyPreview.globalForcedTitle")
            : t("systemSettings.newsSourceScheduler.policyPreview.sourceAwareTitle")
        }
        description={
          isGlobalForced
            ? t("systemSettings.newsSourceScheduler.policyPreview.globalForcedDescription", {
                sitemapRss: previewSeedCacheTtlSecondsSitemapRss,
                listDeep: previewSeedCacheTtlSecondsListDeep,
              })
            : t("systemSettings.newsSourceScheduler.policyPreview.sourceAwareDescription", {
                sitemapRss: previewSeedCacheTtlSecondsSitemapRss,
                listDeep: previewSeedCacheTtlSecondsListDeep,
              })
        }
        style={{ marginBottom: "1rem" }}
      />

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedFreshnessWindowDays")}
          name="seedFreshnessWindowDays"
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedFreshnessWindowDaysRequired",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 3_650,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedFreshnessWindowDaysRange",
              ),
            },
          ]}
          extra={t("systemSettings.newsSourceScheduler.hints.seedFreshnessWindowDays")}
        >
          <InputNumber min={1} max={3_650} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedCacheTtlSecondsSitemapRss")}
          name="seedCacheTtlSecondsSitemapRss"
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsSitemapRssRequired",
              ),
            },
            {
              type: "number",
              min: 10,
              max: 3_600,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsSitemapRssRange",
              ),
            },
          ]}
          extra={t("systemSettings.newsSourceScheduler.hints.seedCacheTtlSecondsSitemapRss")}
        >
          <InputNumber min={10} max={3_600} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedCacheTtlSecondsListDeep")}
          name="seedCacheTtlSecondsListDeep"
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsListDeepRequired",
              ),
            },
            {
              type: "number",
              min: 10,
              max: 3_600,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsListDeepRange",
              ),
            },
          ]}
          extra={t("systemSettings.newsSourceScheduler.hints.seedCacheTtlSecondsListDeep")}
        >
          <InputNumber min={10} max={3_600} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedCacheTtlForceGlobal")}
          name="seedCacheTtlForceGlobal"
          valuePropName="checked"
          extra={t("systemSettings.newsSourceScheduler.hints.seedCacheTtlForceGlobal")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedUrlQueryParamAllowlist", {
            defaultValue: "Seed URL query param allowlist",
          })}
          name="seedUrlQueryParamAllowlist"
          extra={t("systemSettings.newsSourceScheduler.hints.seedUrlQueryParamAllowlist", {
            defaultValue:
              "Only these query keys are kept when canonicalizing discovered URLs (e.g. keep id/page, drop utm_*).",
          })}
          rules={[
            {
              validator: async (_, value: unknown) => {
                const normalized = normalizeQueryAllowlist(value);
                const rawLength = Array.isArray(value) ? value.length : 0;
                if (rawLength > 64) {
                  throw new Error(
                    t(
                      "systemSettings.newsSourceScheduler.validation.seedUrlQueryParamAllowlistLimit",
                      { defaultValue: "At most 64 keys." },
                    ),
                  );
                }
                if (Array.isArray(value) && normalized.length !== rawLength) {
                  throw new Error(
                    t(
                      "systemSettings.newsSourceScheduler.validation.seedUrlQueryParamAllowlistInvalid",
                      {
                        defaultValue:
                          "Each key must match [a-z0-9_.-] and be up to 64 chars.",
                      },
                    ),
                  );
                }
              },
            },
          ]}
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " ", "\n", "\t"]}
            options={DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST.map((entry) => ({
              label: entry,
              value: entry,
            }))}
            placeholder={t(
              "systemSettings.newsSourceScheduler.placeholders.seedUrlQueryParamAllowlist",
              { defaultValue: "id, page, lang" },
            )}
          />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
