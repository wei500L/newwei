'use client';

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createApiClient } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-error';
import { captureClientError } from '@/lib/client-telemetry';
import { emitNewsnowPersonalizationUpdated } from '@/lib/newsnow-personalization-events';

interface NewsnowPersonalizationSettingsResponse {
  source: 'default' | 'db';
  cacheTtlMs: number;
  maxCacheEntries: number;
  throttleWindowMs: number;
  maxRequestsPerWindowPerUser: number;
  affinitySourceWeight: number;
  behaviorSourceWeight: number;
  focusSourceBonus: number;
  staleTtlStrategy: 'multiplier' | 'fixed';
  staleTtlMultiplier: number;
  staleTtlFixedMs: number;
}

interface NewsnowPersonalizationSettingsFormValues {
  cacheTtlMs: number;
  maxCacheEntries: number;
  throttleWindowMs: number;
  maxRequestsPerWindowPerUser: number;
  affinitySourceWeight: number;
  behaviorSourceWeight: number;
  focusSourceBonus: number;
  staleTtlStrategy: 'multiplier' | 'fixed';
  staleTtlMultiplier: number;
  staleTtlFixedMs: number;
}

interface NewsnowPersonalizationRuntimeMetricsTotals {
  requestCount: number;
  cacheHitFreshCount: number;
  cacheHitStaleCount: number;
  cacheHitTotalCount: number;
  cacheHitRate: number;
  throttleLimitedCount: number;
  throttleRejectedCount: number;
  throttleRate: number;
  trimCount: number;
  trimEvictedCount: number;
}

interface NewsnowPersonalizationRuntimeMetricsSnapshot {
  from: string;
  to: string;
  windowDays: number;
  totals: NewsnowPersonalizationRuntimeMetricsTotals;
}

interface UserNewsBehaviorProfileResponse {
  actions: Record<string, number>;
  sources: Record<string, number>;
  topics: Record<string, number>;
  entities: Record<string, number>;
  items: Record<string, number>;
  events: Record<string, number>;
  domains: Record<string, number>;
  positive?: {
    actions: Record<string, number>;
    sources: Record<string, number>;
    topics: Record<string, number>;
    entities: Record<string, number>;
    items: Record<string, number>;
    events: Record<string, number>;
    domains: Record<string, number>;
  };
  negative?: {
    actions: Record<string, number>;
    sources: Record<string, number>;
    topics: Record<string, number>;
    entities: Record<string, number>;
    items: Record<string, number>;
    events: Record<string, number>;
    domains: Record<string, number>;
  };
  bands?: {
    key: string;
    weight: number;
    positive: Record<string, Record<string, number>>;
    negative: Record<string, Record<string, number>>;
    net: Record<string, Record<string, number>>;
  }[];
  meta?: {
    legacyFallbackUsed?: boolean;
    decayPolicy?: {
      strategy?: string;
      halfLifeDays?: number;
      windowDays?: number;
    };
  };
}

const DEFAULT_SETTINGS: NewsnowPersonalizationSettingsResponse = {
  source: 'default',
  cacheTtlMs: 20_000,
  maxCacheEntries: 2_000,
  throttleWindowMs: 10_000,
  maxRequestsPerWindowPerUser: 40,
  affinitySourceWeight: 0.42,
  behaviorSourceWeight: 0.58,
  focusSourceBonus: 0.35,
  staleTtlStrategy: 'multiplier',
  staleTtlMultiplier: 3,
  staleTtlFixedMs: 60_000,
};

const ERROR_CODE_I18N_KEY: Record<string, string> = {
  NEWSNOW_PERSONALIZATION_SETTINGS_INVALID:
    'systemSettings.newsnowPersonalization.errors.codes.NEWSNOW_PERSONALIZATION_SETTINGS_INVALID',
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

function formatRate(value: number): string {
  const numeric = Number.isFinite(value) ? value : 0;
  return `${(numeric * 100).toFixed(2)}%`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function normalizeSettingsForFingerprint(
  input: Partial<NewsnowPersonalizationSettingsFormValues> | null | undefined,
): NewsnowPersonalizationSettingsFormValues {
  const next = input ?? {};
  return {
    cacheTtlMs:
      typeof next.cacheTtlMs === 'number' && Number.isFinite(next.cacheTtlMs)
        ? next.cacheTtlMs
        : DEFAULT_SETTINGS.cacheTtlMs,
    maxCacheEntries:
      typeof next.maxCacheEntries === 'number' && Number.isFinite(next.maxCacheEntries)
        ? next.maxCacheEntries
        : DEFAULT_SETTINGS.maxCacheEntries,
    throttleWindowMs:
      typeof next.throttleWindowMs === 'number' && Number.isFinite(next.throttleWindowMs)
        ? next.throttleWindowMs
        : DEFAULT_SETTINGS.throttleWindowMs,
    maxRequestsPerWindowPerUser:
      typeof next.maxRequestsPerWindowPerUser === 'number' &&
      Number.isFinite(next.maxRequestsPerWindowPerUser)
        ? next.maxRequestsPerWindowPerUser
        : DEFAULT_SETTINGS.maxRequestsPerWindowPerUser,
    affinitySourceWeight:
      typeof next.affinitySourceWeight === 'number' &&
      Number.isFinite(next.affinitySourceWeight)
        ? next.affinitySourceWeight
        : DEFAULT_SETTINGS.affinitySourceWeight,
    behaviorSourceWeight:
      typeof next.behaviorSourceWeight === 'number' &&
      Number.isFinite(next.behaviorSourceWeight)
        ? next.behaviorSourceWeight
        : DEFAULT_SETTINGS.behaviorSourceWeight,
    focusSourceBonus:
      typeof next.focusSourceBonus === 'number' && Number.isFinite(next.focusSourceBonus)
        ? next.focusSourceBonus
        : DEFAULT_SETTINGS.focusSourceBonus,
    staleTtlStrategy:
      next.staleTtlStrategy === 'fixed' || next.staleTtlStrategy === 'multiplier'
        ? next.staleTtlStrategy
        : DEFAULT_SETTINGS.staleTtlStrategy,
    staleTtlMultiplier:
      typeof next.staleTtlMultiplier === 'number' && Number.isFinite(next.staleTtlMultiplier)
        ? next.staleTtlMultiplier
        : DEFAULT_SETTINGS.staleTtlMultiplier,
    staleTtlFixedMs:
      typeof next.staleTtlFixedMs === 'number' && Number.isFinite(next.staleTtlFixedMs)
        ? next.staleTtlFixedMs
        : DEFAULT_SETTINGS.staleTtlFixedMs,
  };
}

function buildSettingsFingerprint(
  input: Partial<NewsnowPersonalizationSettingsFormValues> | null | undefined,
): string {
  return stableStringify(normalizeSettingsForFingerprint(input));
}

function topBehaviorEntries(
  record: Record<string, number> | undefined,
  limit = 8,
): [string, number][] {
  if (!record) {
    return [];
  }
  return Object.entries(record)
    .filter((entry) => Number.isFinite(entry[1]) && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function NewsnowPersonalizationSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<NewsnowPersonalizationSettingsFormValues>();
  const [settings, setSettings] =
    useState<NewsnowPersonalizationSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [metrics, setMetrics] =
    useState<NewsnowPersonalizationRuntimeMetricsSnapshot | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsErrorMessage, setMetricsErrorMessage] = useState<string | null>(null);
  const [behaviorProfile, setBehaviorProfile] =
    useState<UserNewsBehaviorProfileResponse | null>(null);
  const [behaviorProfileLoading, setBehaviorProfileLoading] = useState(false);
  const [behaviorProfileErrorMessage, setBehaviorProfileErrorMessage] =
    useState<string | null>(null);
  const [clearingBehaviorProfile, setClearingBehaviorProfile] = useState(false);
  const [savedSettingsFingerprint, setSavedSettingsFingerprint] =
    useState<string | null>(null);
  const formValues = Form.useWatch([], form) as
    | Partial<NewsnowPersonalizationSettingsFormValues>
    | undefined;
  const staleTtlStrategy = Form.useWatch('staleTtlStrategy', form);
  const affinitySourceWeight = Form.useWatch('affinitySourceWeight', form);
  const behaviorSourceWeight = Form.useWatch('behaviorSourceWeight', form);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response =
        await apiClient.get<NewsnowPersonalizationSettingsResponse>(
          'system-settings/newsnow-personalization',
        );
      const data: NewsnowPersonalizationSettingsResponse = {
        ...DEFAULT_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue({
        cacheTtlMs: data.cacheTtlMs,
        maxCacheEntries: data.maxCacheEntries,
        throttleWindowMs: data.throttleWindowMs,
        maxRequestsPerWindowPerUser: data.maxRequestsPerWindowPerUser,
        affinitySourceWeight: data.affinitySourceWeight,
        behaviorSourceWeight: data.behaviorSourceWeight,
        focusSourceBonus: data.focusSourceBonus,
        staleTtlStrategy: data.staleTtlStrategy,
        staleTtlMultiplier: data.staleTtlMultiplier,
        staleTtlFixedMs: data.staleTtlFixedMs,
      });
      setSavedSettingsFingerprint(buildSettingsFingerprint(data));
    } catch (error) {
      captureClientError('Failed to load NewsNow personalization settings', error);
      const detail = formatApiError(
        error,
        t('systemSettings.newsnowPersonalization.errors.loadFailed'),
        t,
      );
      setErrorMessage(detail);
      setSettings(null);
      form.setFieldsValue({
        cacheTtlMs: DEFAULT_SETTINGS.cacheTtlMs,
        maxCacheEntries: DEFAULT_SETTINGS.maxCacheEntries,
        throttleWindowMs: DEFAULT_SETTINGS.throttleWindowMs,
        maxRequestsPerWindowPerUser:
          DEFAULT_SETTINGS.maxRequestsPerWindowPerUser,
        affinitySourceWeight: DEFAULT_SETTINGS.affinitySourceWeight,
        behaviorSourceWeight: DEFAULT_SETTINGS.behaviorSourceWeight,
        focusSourceBonus: DEFAULT_SETTINGS.focusSourceBonus,
        staleTtlStrategy: DEFAULT_SETTINGS.staleTtlStrategy,
        staleTtlMultiplier: DEFAULT_SETTINGS.staleTtlMultiplier,
        staleTtlFixedMs: DEFAULT_SETTINGS.staleTtlFixedMs,
      });
      setSavedSettingsFingerprint(buildSettingsFingerprint(DEFAULT_SETTINGS));
      messageApi.error(detail);
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, messageApi, t]);

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    setMetricsErrorMessage(null);
    try {
      const response =
        await apiClient.get<NewsnowPersonalizationRuntimeMetricsSnapshot>(
          'system-settings/newsnow-personalization/metrics?days=7',
        );
      setMetrics(response.data ?? null);
    } catch (error) {
      captureClientError(
        'Failed to load NewsNow personalization runtime metrics',
        error,
      );
      const detail = formatApiError(
        error,
        t('systemSettings.newsnowPersonalization.errors.metricsLoadFailed'),
        t,
      );
      setMetricsErrorMessage(detail);
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, [apiClient, t]);

  const loadBehaviorProfile = useCallback(async () => {
    setBehaviorProfileLoading(true);
    setBehaviorProfileErrorMessage(null);
    try {
      const response = await apiClient.get<UserNewsBehaviorProfileResponse>(
        'user-news-behavior/profile',
      );
      setBehaviorProfile(response.data ?? null);
    } catch (error) {
      captureClientError('Failed to load NewsNow behavior profile', error);
      const detail = formatApiError(
        error,
        t('systemSettings.newsnowPersonalization.errors.behaviorProfileLoadFailed'),
        t,
      );
      setBehaviorProfileErrorMessage(detail);
      setBehaviorProfile(null);
    } finally {
      setBehaviorProfileLoading(false);
    }
  }, [apiClient, t]);

  const handleClearBehaviorProfile = useCallback(async () => {
    setClearingBehaviorProfile(true);
    try {
      await apiClient.delete('user-news-behavior/profile');
      emitNewsnowPersonalizationUpdated({ updatedAt: Date.now() });
      messageApi.success(
        t('systemSettings.newsnowPersonalization.messages.behaviorProfileCleared'),
      );
      await loadBehaviorProfile();
    } catch (error) {
      captureClientError('Failed to clear NewsNow behavior profile', error);
      const detail = formatApiError(
        error,
        t('systemSettings.newsnowPersonalization.errors.behaviorProfileClearFailed'),
        t,
      );
      messageApi.error(detail);
    } finally {
      setClearingBehaviorProfile(false);
    }
  }, [apiClient, loadBehaviorProfile, messageApi, t]);

  const confirmClearBehaviorProfile = useCallback(() => {
    Modal.confirm({
      title: t(
        'systemSettings.newsnowPersonalization.behaviorProfile.clearConfirmTitle',
      ),
      content: t(
        'systemSettings.newsnowPersonalization.behaviorProfile.clearConfirmDescription',
      ),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        await handleClearBehaviorProfile();
      },
    });
  }, [handleClearBehaviorProfile, t]);

  useEffect(() => {
    void loadSettings();
    void loadMetrics();
    void loadBehaviorProfile();
  }, [loadBehaviorProfile, loadMetrics, loadSettings]);

  const handleSubmit = async (
    values: NewsnowPersonalizationSettingsFormValues,
  ) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const response =
        await apiClient.put<NewsnowPersonalizationSettingsResponse>(
          'system-settings/newsnow-personalization',
          values,
        );
      const data: NewsnowPersonalizationSettingsResponse = {
        ...DEFAULT_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue({
        cacheTtlMs: data.cacheTtlMs,
        maxCacheEntries: data.maxCacheEntries,
        throttleWindowMs: data.throttleWindowMs,
        maxRequestsPerWindowPerUser: data.maxRequestsPerWindowPerUser,
        affinitySourceWeight: data.affinitySourceWeight,
        behaviorSourceWeight: data.behaviorSourceWeight,
        focusSourceBonus: data.focusSourceBonus,
        staleTtlStrategy: data.staleTtlStrategy,
        staleTtlMultiplier: data.staleTtlMultiplier,
        staleTtlFixedMs: data.staleTtlFixedMs,
      });
      setSavedSettingsFingerprint(buildSettingsFingerprint(data));
      emitNewsnowPersonalizationUpdated({ updatedAt: Date.now() });
      messageApi.success(t('systemSettings.newsnowPersonalization.messages.saved'));
      void loadMetrics();
    } catch (error) {
      captureClientError('Failed to save NewsNow personalization settings', error);
      const detail = formatApiError(
        error,
        t('systemSettings.newsnowPersonalization.errors.saveFailed'),
        t,
      );
      setErrorMessage(detail);
      messageApi.error(detail);
    } finally {
      setSaving(false);
    }
  };

  const sourceColor = settings?.source === 'db' ? 'green' : 'default';
  const sourceLabel =
    settings?.source === 'db'
      ? t('systemSettings.newsnowPersonalization.status.saved')
      : settings?.source === 'default'
        ? t('systemSettings.newsnowPersonalization.status.default')
        : t('systemSettings.newsnowPersonalization.status.unavailable');
  const normalizedWeightRatios = useMemo(() => {
    const affinity =
      typeof affinitySourceWeight === 'number' && Number.isFinite(affinitySourceWeight)
        ? Math.max(0, affinitySourceWeight)
        : 0;
    const behavior =
      typeof behaviorSourceWeight === 'number' && Number.isFinite(behaviorSourceWeight)
        ? Math.max(0, behaviorSourceWeight)
        : 0;
    const total = affinity + behavior;
    if (total <= 0) {
      return null;
    }
    return {
      affinity: affinity / total,
      behavior: behavior / total,
    };
  }, [affinitySourceWeight, behaviorSourceWeight]);
  const currentSettingsFingerprint = useMemo(
    () => buildSettingsFingerprint(formValues),
    [formValues],
  );
  const isSettingsDirty = useMemo(() => {
    if (!savedSettingsFingerprint) {
      return false;
    }
    return currentSettingsFingerprint !== savedSettingsFingerprint;
  }, [currentSettingsFingerprint, savedSettingsFingerprint]);
  const behaviorDimensions = useMemo(
    () => [
      {
        key: 'sources',
        label: t('systemSettings.newsnowPersonalization.behaviorProfile.sections.sources'),
      },
      {
        key: 'topics',
        label: t('systemSettings.newsnowPersonalization.behaviorProfile.sections.topics'),
      },
      {
        key: 'entities',
        label: t('systemSettings.newsnowPersonalization.behaviorProfile.sections.entities'),
      },
      {
        key: 'domains',
        label: t('systemSettings.newsnowPersonalization.behaviorProfile.sections.domains'),
      },
      {
        key: 'items',
        label: t('systemSettings.newsnowPersonalization.behaviorProfile.sections.items'),
      },
      {
        key: 'events',
        label: t('systemSettings.newsnowPersonalization.behaviorProfile.sections.events'),
      },
    ],
    [t],
  );
  const handleRestoreDefaults = useCallback(() => {
    form.setFieldsValue(normalizeSettingsForFingerprint(DEFAULT_SETTINGS));
    messageApi.info(
      t('systemSettings.newsnowPersonalization.messages.defaultsRestored'),
    );
  }, [form, messageApi, t]);

  useEffect(() => {
    if (!isSettingsDirty || typeof window === 'undefined') {
      return;
    }
    const beforeUnloadHandler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
    return () => {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
    };
  }, [isSettingsDirty]);

  if (loading && settings === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: '1rem' }}>
        {t('systemSettings.newsnowPersonalization.description')}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t('systemSettings.newsnowPersonalization.notice.title')}
        description={t('systemSettings.newsnowPersonalization.notice.body')}
        style={{ marginBottom: '1rem' }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: '1rem' }} />
      ) : null}
      {isSettingsDirty ? (
        <Alert
          type="warning"
          showIcon
          message={t('systemSettings.newsnowPersonalization.unsaved.title')}
          description={t('systemSettings.newsnowPersonalization.unsaved.description')}
          style={{ marginBottom: '1rem' }}
        />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: 'flex', marginBottom: '1rem' }}>
        <Space wrap>
          <Typography.Text>
            {t('systemSettings.newsnowPersonalization.status.label')}
          </Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
        </Space>
      </Space>

      <Divider style={{ margin: '12px 0' }} />

      <Space
        align="center"
        style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}
      >
        <Typography.Text strong>
          {t('systemSettings.newsnowPersonalization.metrics.title')}
        </Typography.Text>
        <Button size="small" onClick={() => void loadMetrics()} loading={metricsLoading}>
          {t('common.refresh')}
        </Button>
      </Space>

      <Typography.Paragraph type="secondary" style={{ marginBottom: '0.75rem' }}>
        {t('systemSettings.newsnowPersonalization.metrics.description')}
      </Typography.Paragraph>

      {metricsErrorMessage ? (
        <Alert
          type="warning"
          showIcon
          message={metricsErrorMessage}
          style={{ marginBottom: '0.75rem' }}
        />
      ) : null}

      <Descriptions
        bordered
        size="small"
        column={1}
        style={{ marginBottom: '1rem' }}
        title={
          metrics
            ? t('systemSettings.newsnowPersonalization.metrics.window', {
                from: metrics.from,
                to: metrics.to,
                days: metrics.windowDays,
              })
            : undefined
        }
      >
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.requestCount')}
        >
          {metrics?.totals.requestCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.cacheHitFreshCount')}
        >
          {metrics?.totals.cacheHitFreshCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.cacheHitStaleCount')}
        >
          {metrics?.totals.cacheHitStaleCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.cacheHitRate')}
        >
          {formatRate(metrics?.totals.cacheHitRate ?? 0)}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.throttleLimitedCount')}
        >
          {metrics?.totals.throttleLimitedCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.throttleRejectedCount')}
        >
          {metrics?.totals.throttleRejectedCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.throttleRate')}
        >
          {formatRate(metrics?.totals.throttleRate ?? 0)}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.trimCount')}
        >
          {metrics?.totals.trimCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('systemSettings.newsnowPersonalization.metrics.trimEvictedCount')}
        >
          {metrics?.totals.trimEvictedCount ?? 0}
        </Descriptions.Item>
      </Descriptions>

      <Divider style={{ margin: '12px 0' }} />

      <Space
        align="center"
        style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}
      >
        <Typography.Text strong>
          {t('systemSettings.newsnowPersonalization.behaviorProfile.title')}
        </Typography.Text>
        <Space>
          <Button
            size="small"
            onClick={() => void loadBehaviorProfile()}
            loading={behaviorProfileLoading}
          >
            {t('common.refresh')}
          </Button>
          <Button
            size="small"
            danger
            htmlType="button"
            loading={clearingBehaviorProfile}
            onClick={confirmClearBehaviorProfile}
          >
            {t('systemSettings.newsnowPersonalization.behaviorProfile.clearAction')}
          </Button>
        </Space>
      </Space>

      <Typography.Paragraph type="secondary" style={{ marginBottom: '0.75rem' }}>
        {t('systemSettings.newsnowPersonalization.behaviorProfile.description')}
      </Typography.Paragraph>

      {behaviorProfileErrorMessage ? (
        <Alert
          type="warning"
          showIcon
          message={behaviorProfileErrorMessage}
          style={{ marginBottom: '0.75rem' }}
        />
      ) : null}
      {behaviorProfile?.meta?.legacyFallbackUsed ? (
        <Alert
          type="info"
          showIcon
          message={t('systemSettings.newsnowPersonalization.behaviorProfile.legacyFallback')}
          style={{ marginBottom: '0.75rem' }}
        />
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
          marginBottom: '1rem',
        }}
      >
        {behaviorDimensions.map((section) => {
          const entries = topBehaviorEntries(
            behaviorProfile?.[section.key as keyof UserNewsBehaviorProfileResponse] as
              | Record<string, number>
              | undefined,
          );
          return (
            <Card
              key={section.key}
              size="small"
              title={`${section.label} · ${t(
                'systemSettings.newsnowPersonalization.behaviorProfile.sections.combined',
              )}`}
              loading={behaviorProfileLoading}
            >
              {entries.length > 0 ? (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {entries.map(([key, value]) => (
                    <div
                      key={`${section.key}:${key}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <Typography.Text
                        ellipsis={{ tooltip: key }}
                        style={{ maxWidth: '70%' }}
                      >
                        {key}
                      </Typography.Text>
                      <Tag>{value.toFixed(2)}</Tag>
                    </div>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {t('systemSettings.newsnowPersonalization.behaviorProfile.empty')}
                </Typography.Text>
              )}
            </Card>
          );
        })}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
          marginBottom: '1rem',
        }}
      >
        {behaviorDimensions.map((section) => {
          const positiveEntries = topBehaviorEntries(
            behaviorProfile?.positive?.[section.key as keyof NonNullable<UserNewsBehaviorProfileResponse['positive']>],
          );
          const negativeEntries = topBehaviorEntries(
            behaviorProfile?.negative?.[section.key as keyof NonNullable<UserNewsBehaviorProfileResponse['negative']>],
          );
          return (
            <Card
              key={`polarity-${section.key}`}
              size="small"
              title={section.label}
              loading={behaviorProfileLoading}
            >
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <div>
                  <Typography.Text strong>
                    {t('systemSettings.newsnowPersonalization.behaviorProfile.sections.positive')}
                  </Typography.Text>
                  {positiveEntries.length > 0 ? (
                    <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
                      {positiveEntries.slice(0, 4).map(([key, value]) => (
                        <div
                          key={`positive-${section.key}-${key}`}
                          style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                        >
                          <Typography.Text ellipsis={{ tooltip: key }} style={{ maxWidth: '70%' }}>
                            {key}
                          </Typography.Text>
                          <Tag color="green">{value.toFixed(2)}</Tag>
                        </div>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">
                      {t('systemSettings.newsnowPersonalization.behaviorProfile.empty')}
                    </Typography.Text>
                  )}
                </div>
                <div>
                  <Typography.Text strong>
                    {t('systemSettings.newsnowPersonalization.behaviorProfile.sections.negative')}
                  </Typography.Text>
                  {negativeEntries.length > 0 ? (
                    <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
                      {negativeEntries.slice(0, 4).map(([key, value]) => (
                        <div
                          key={`negative-${section.key}-${key}`}
                          style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                        >
                          <Typography.Text ellipsis={{ tooltip: key }} style={{ maxWidth: '70%' }}>
                            {key}
                          </Typography.Text>
                          <Tag color="red">{value.toFixed(2)}</Tag>
                        </div>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">
                      {t('systemSettings.newsnowPersonalization.behaviorProfile.empty')}
                    </Typography.Text>
                  )}
                </div>
              </Space>
            </Card>
          );
        })}
      </div>
      {(behaviorProfile?.bands ?? []).length > 0 ? (
        <Card
          size="small"
          title={t(
            'systemSettings.newsnowPersonalization.behaviorProfile.decayTitle',
          )}
          style={{ marginBottom: '1rem' }}
        >
          <Space wrap size={[8, 8]}>
            {behaviorProfile?.meta?.decayPolicy?.halfLifeDays ? (
              <Tag color="blue">
                {t(
                  'systemSettings.newsnowPersonalization.behaviorProfile.decayPolicy',
                  {
                    halfLifeDays: behaviorProfile.meta.decayPolicy.halfLifeDays,
                  },
                )}
              </Tag>
            ) : null}
            {(behaviorProfile?.bands ?? []).map((band) => (
              <Tag key={band.key}>
                {band.key} ·{' '}
                {t(
                  'systemSettings.newsnowPersonalization.behaviorProfile.averageDecay',
                  {
                    value: (band.weight * 100).toFixed(0),
                  },
                )}
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}

      <Form
        name="newsnow-personalization-settings"
        layout="vertical"
        form={form}
        onFinish={handleSubmit}
      >
        <Alert
          type={normalizedWeightRatios ? 'info' : 'warning'}
          showIcon
          message={t('systemSettings.newsnowPersonalization.weightPreview.title')}
          description={
            normalizedWeightRatios
              ? t('systemSettings.newsnowPersonalization.weightPreview.body', {
                  behavior: formatRate(normalizedWeightRatios.behavior),
                  affinity: formatRate(normalizedWeightRatios.affinity),
                })
              : t('systemSettings.newsnowPersonalization.weightPreview.invalid')
          }
          style={{ marginBottom: '1rem' }}
        />

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.affinitySourceWeight')}
          name="affinitySourceWeight"
          dependencies={['behaviorSourceWeight']}
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.affinitySourceWeightRequired',
              ),
            },
            {
              type: 'number',
              min: 0,
              max: 5,
              message: t(
                'systemSettings.newsnowPersonalization.validation.affinitySourceWeightRange',
              ),
            },
            ({ getFieldValue }) => ({
              validator(_, value) {
                const affinity =
                  typeof value === 'number' && Number.isFinite(value) ? value : 0;
                const behaviorRaw = getFieldValue('behaviorSourceWeight');
                const behavior =
                  typeof behaviorRaw === 'number' && Number.isFinite(behaviorRaw)
                    ? behaviorRaw
                    : 0;
                if (affinity + behavior <= 0) {
                  return Promise.reject(
                    new Error(
                      t('systemSettings.newsnowPersonalization.validation.signalWeightSum'),
                    ),
                  );
                }
                return Promise.resolve();
              },
            }),
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.affinitySourceWeight')}
        >
          <InputNumber
            min={0}
            max={5}
            step={0.01}
            precision={4}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.behaviorSourceWeight')}
          name="behaviorSourceWeight"
          dependencies={['affinitySourceWeight']}
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.behaviorSourceWeightRequired',
              ),
            },
            {
              type: 'number',
              min: 0,
              max: 5,
              message: t(
                'systemSettings.newsnowPersonalization.validation.behaviorSourceWeightRange',
              ),
            },
            ({ getFieldValue }) => ({
              validator(_, value) {
                const behavior =
                  typeof value === 'number' && Number.isFinite(value) ? value : 0;
                const affinityRaw = getFieldValue('affinitySourceWeight');
                const affinity =
                  typeof affinityRaw === 'number' && Number.isFinite(affinityRaw)
                    ? affinityRaw
                    : 0;
                if (affinity + behavior <= 0) {
                  return Promise.reject(
                    new Error(
                      t('systemSettings.newsnowPersonalization.validation.signalWeightSum'),
                    ),
                  );
                }
                return Promise.resolve();
              },
            }),
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.behaviorSourceWeight')}
        >
          <InputNumber
            min={0}
            max={5}
            step={0.01}
            precision={4}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.focusSourceBonus')}
          name="focusSourceBonus"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.focusSourceBonusRequired',
              ),
            },
            {
              type: 'number',
              min: 0,
              max: 20,
              message: t(
                'systemSettings.newsnowPersonalization.validation.focusSourceBonusRange',
              ),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.focusSourceBonus')}
        >
          <InputNumber
            min={0}
            max={20}
            step={0.05}
            precision={4}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.cacheTtlMs')}
          name="cacheTtlMs"
          rules={[
            {
              required: true,
              message: t('systemSettings.newsnowPersonalization.validation.cacheTtlMsRequired'),
            },
            {
              type: 'number',
              min: 0,
              max: 300_000,
              message: t('systemSettings.newsnowPersonalization.validation.cacheTtlMsRange'),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.cacheTtlMs')}
        >
          <InputNumber min={0} max={300_000} step={100} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.maxCacheEntries')}
          name="maxCacheEntries"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.maxCacheEntriesRequired',
              ),
            },
            {
              type: 'number',
              min: 100,
              max: 20_000,
              message: t(
                'systemSettings.newsnowPersonalization.validation.maxCacheEntriesRange',
              ),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.maxCacheEntries')}
        >
          <InputNumber min={100} max={20_000} step={100} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.throttleWindowMs')}
          name="throttleWindowMs"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.throttleWindowMsRequired',
              ),
            },
            {
              type: 'number',
              min: 1_000,
              max: 600_000,
              message: t(
                'systemSettings.newsnowPersonalization.validation.throttleWindowMsRange',
              ),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.throttleWindowMs')}
        >
          <InputNumber min={1_000} max={600_000} step={500} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label={t(
            'systemSettings.newsnowPersonalization.fields.maxRequestsPerWindowPerUser',
          )}
          name="maxRequestsPerWindowPerUser"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.maxRequestsPerWindowPerUserRequired',
              ),
            },
            {
              type: 'number',
              min: 1,
              max: 500,
              message: t(
                'systemSettings.newsnowPersonalization.validation.maxRequestsPerWindowPerUserRange',
              ),
            },
          ]}
          extra={t(
            'systemSettings.newsnowPersonalization.hints.maxRequestsPerWindowPerUser',
          )}
        >
          <InputNumber min={1} max={500} step={1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.staleTtlStrategy')}
          name="staleTtlStrategy"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.staleTtlStrategyRequired',
              ),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.staleTtlStrategy')}
        >
          <Select
            options={[
              {
                value: 'multiplier',
                label: t(
                  'systemSettings.newsnowPersonalization.options.staleTtlStrategyMultiplier',
                ),
              },
              {
                value: 'fixed',
                label: t('systemSettings.newsnowPersonalization.options.staleTtlStrategyFixed'),
              },
            ]}
          />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.staleTtlMultiplier')}
          name="staleTtlMultiplier"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.staleTtlMultiplierRequired',
              ),
            },
            {
              type: 'number',
              min: 1,
              max: 20,
              message: t(
                'systemSettings.newsnowPersonalization.validation.staleTtlMultiplierRange',
              ),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.staleTtlMultiplier')}
        >
          <InputNumber
            min={1}
            max={20}
            step={1}
            style={{ width: '100%' }}
            disabled={staleTtlStrategy === 'fixed'}
          />
        </Form.Item>

        <Form.Item
          label={t('systemSettings.newsnowPersonalization.fields.staleTtlFixedMs')}
          name="staleTtlFixedMs"
          rules={[
            {
              required: true,
              message: t(
                'systemSettings.newsnowPersonalization.validation.staleTtlFixedMsRequired',
              ),
            },
            {
              type: 'number',
              min: 1_000,
              max: 3_600_000,
              message: t(
                'systemSettings.newsnowPersonalization.validation.staleTtlFixedMsRange',
              ),
            },
          ]}
          extra={t('systemSettings.newsnowPersonalization.hints.staleTtlFixedMs')}
        >
          <InputNumber
            min={1_000}
            max={3_600_000}
            step={1_000}
            style={{ width: '100%' }}
            disabled={staleTtlStrategy === 'multiplier'}
          />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t('common.saveChanges')}
            </Button>
            <Popconfirm
              title={t(
                'systemSettings.newsnowPersonalization.restoreDefaults.confirmTitle',
              )}
              description={t(
                'systemSettings.newsnowPersonalization.restoreDefaults.confirmDescription',
              )}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              onConfirm={() => handleRestoreDefaults()}
            >
              <Button>
                {t(
                  'systemSettings.newsnowPersonalization.restoreDefaults.action',
                )}
              </Button>
            </Popconfirm>
          </Space>
        </Form.Item>
      </Form>
    </>
  );
}
