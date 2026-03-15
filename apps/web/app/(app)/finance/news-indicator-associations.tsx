"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import { Button, Card, Drawer, Empty, Input, List, Select, Skeleton, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { captureClientError } from "@/lib/client-telemetry";
import { normalizeUnit } from "@/lib/economic-units";
import { formatDateTime, resolveLocale, type SupportedLocale } from "@/lib/i18n";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";

type NewsIndicatorScopeType = "entity" | "topic";
type NewsIndicatorFeatureMetric = "volume" | "avg_score" | "negative_ratio";
type NewsIndicatorBacktestStatus = "pending" | "running" | "completed" | "failed";

interface BacktestSummaryLabels {
  hitRate: string;
  avgSignedReturn: string;
  triggers: string;
}

interface EconomicDataItem {
  slug: string;
  displayName: string;
  groupLabel?: string | null;
  defaultUnit?: string | null;
  metadata?: unknown;
}

interface BacktestRun {
  id: string;
  status: NewsIndicatorBacktestStatus;
  windowStart: string;
  windowEnd: string;
  config?: unknown;
  metrics?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Association {
  id: string;
  scopeType: NewsIndicatorScopeType;
  scopeKey: string;
  scopeKeyType: string;
  featureMetric: NewsIndicatorFeatureMetric;
  indicator: EconomicDataItem;
  windowDays: number;
  lagDays: number;
  correlation: number;
  pValue?: number | null;
  sampleSize: number;
  analyzedStartAt: string;
  analyzedEndAt: string;
  lastEvaluatedAt: string;
  metadata?: unknown;
  latestBacktest?: BacktestRun | null;
}

interface AssociationDetails extends Association {
  backtests?: BacktestRun[];
}

interface NewsIndicatorSettings {
  enabled: boolean;
  ingestionEnabled: boolean;
  windowDays: number;
  minSampleSize: number;
  indicatorSlugs: string[];
}

const NEWS_INDICATOR_SETTINGS_QUERY = gql`
  query NewsIndicatorSettingsForUi {
    newsIndicatorSettings {
      enabled
      ingestionEnabled
      windowDays
      minSampleSize
      indicatorSlugs
    }
  }
`;

const NEWS_INDICATOR_ASSOCIATIONS_QUERY = gql`
  query NewsIndicatorAssociations(
    $limit: Int
    $indicatorSlug: String
    $scopeType: NewsIndicatorScopeType
    $scopeKey: String
    $featureMetric: NewsIndicatorFeatureMetric
  ) {
    newsIndicatorAssociations(
      limit: $limit
      indicatorSlug: $indicatorSlug
      scopeType: $scopeType
      scopeKey: $scopeKey
      featureMetric: $featureMetric
    ) {
      id
      scopeType
      scopeKey
      scopeKeyType
      featureMetric
      indicator {
        slug
        displayName
        groupLabel
        defaultUnit
        metadata
      }
      windowDays
      lagDays
      correlation
      pValue
      sampleSize
      analyzedStartAt
      analyzedEndAt
      lastEvaluatedAt
      metadata
      latestBacktest {
        id
        status
        windowStart
        windowEnd
        config
        metrics
        error
        createdAt
        updatedAt
      }
    }
  }
`;

const NEWS_INDICATOR_ASSOCIATION_QUERY = gql`
  query NewsIndicatorAssociation($id: String!, $backtestsLimit: Int) {
    newsIndicatorAssociation(id: $id, backtestsLimit: $backtestsLimit) {
      id
      scopeType
      scopeKey
      scopeKeyType
      featureMetric
      indicator {
        slug
        displayName
        groupLabel
        defaultUnit
        metadata
      }
      windowDays
      lagDays
      correlation
      pValue
      sampleSize
      analyzedStartAt
      analyzedEndAt
      lastEvaluatedAt
      metadata
      backtests {
        id
        status
        windowStart
        windowEnd
        config
        metrics
        error
        createdAt
        updatedAt
      }
    }
  }
`;

const REFRESH_NEWS_INDICATOR_ASSOCIATIONS_MUTATION = gql`
  mutation RefreshNewsIndicatorAssociations {
    refreshNewsIndicatorAssociations
  }
`;

function formatCorrelation(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `r=${value.toFixed(3)}`;
}

function formatSignificanceStars(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  // Conventional thresholds: * p<0.1, ** p<0.05, *** p<0.01
  if (value < 0.01) return "***";
  if (value < 0.05) return "**";
  if (value < 0.1) return "*";
  return "";
}

function formatPValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const stars = formatSignificanceStars(value);
  if (value < 0.0001) {
    return `<0.0001${stars}`;
  }
  return `${value.toFixed(4)}${stars}`;
}

function pickBacktestMetric(metrics: unknown, key: string): number | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return null;
  }
  const record = metrics as Record<string, unknown>;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}

function getBacktestSummary(run: BacktestRun | null | undefined, labels: BacktestSummaryLabels) {
  if (!run?.metrics) {
    return null;
  }
  const hitRate = pickBacktestMetric(run.metrics, "hitRate");
  const avgSignedReturn = pickBacktestMetric(run.metrics, "avgSignedReturn");
  const triggers = pickBacktestMetric(run.metrics, "triggers");
  const summary: string[] = [];
  const hitRateText = formatPercent(hitRate);
  if (hitRateText) {
    summary.push(`${labels.hitRate} ${hitRateText}`);
  }
  if (avgSignedReturn !== null) {
    summary.push(`${labels.avgSignedReturn} ${avgSignedReturn.toFixed(4)}`);
  }
  if (triggers !== null) {
    summary.push(`${labels.triggers} ${Math.round(triggers)}`);
  }
  return summary.length > 0 ? summary.join(" | ") : null;
}

function getScopeTypeLabel(t: (key: string, options?: Record<string, unknown>) => string, value: NewsIndicatorScopeType) {
  if (value === "entity") {
    return t("pages.newsIndicator.filters.scopeType.entity", { defaultValue: "Entity" });
  }
  return t("pages.newsIndicator.filters.scopeType.topic", { defaultValue: "Topic" });
}

function getFeatureMetricLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  value: NewsIndicatorFeatureMetric
) {
  if (value === "volume") {
    return t("pages.newsIndicator.filters.featureMetric.volume", { defaultValue: "Volume" });
  }
  if (value === "avg_score") {
    return t("pages.newsIndicator.filters.featureMetric.avgScore", { defaultValue: "Avg score" });
  }
  return t("pages.newsIndicator.filters.featureMetric.negativeRatio", { defaultValue: "Negative ratio" });
}

function getBacktestStatusLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  value: NewsIndicatorBacktestStatus
) {
  if (value === "pending") {
    return t("pages.newsIndicator.status.pending", { defaultValue: "Pending" });
  }
  if (value === "running") {
    return t("pages.newsIndicator.status.running", { defaultValue: "Running" });
  }
  if (value === "completed") {
    return t("pages.newsIndicator.status.completed", { defaultValue: "Completed" });
  }
  return t("pages.newsIndicator.status.failed", { defaultValue: "Failed" });
}

export function NewsIndicatorAssociations() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canRefresh = permissions.includes("settings.manage");

  const [messageApi, contextHolder] = message.useMessage();
  const [limit, setLimit] = useState<number>(50);
  const [indicatorSlug, setIndicatorSlug] = useState<string | undefined>(undefined);
  const [scopeType, setScopeType] = useState<NewsIndicatorScopeType | undefined>(undefined);
  const [featureMetric, setFeatureMetric] = useState<NewsIndicatorFeatureMetric | undefined>(undefined);
  const [scopeKey, setScopeKey] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    data: settingsData,
    loading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings
  } = useQuery<{
    newsIndicatorSettings: NewsIndicatorSettings;
  }>(NEWS_INDICATOR_SETTINGS_QUERY, { fetchPolicy: "cache-and-network" });

  const settings = settingsData?.newsIndicatorSettings;
  const enabled = settings?.enabled ?? true;
  const ingestionEnabled = settings?.ingestionEnabled ?? true;
  const windowDays = settings?.windowDays ?? 180;
  const minSampleSize = settings?.minSampleSize ?? 30;
  const hasIndicatorSlugs = (settings?.indicatorSlugs ?? []).length > 0;

  const {
    data: assocData,
    loading: assocLoading,
    error: assocError,
    refetch: refetchAssociations
  } = useQuery<{ newsIndicatorAssociations: Association[] }>(NEWS_INDICATOR_ASSOCIATIONS_QUERY, {
    variables: {
      limit,
      indicatorSlug,
      scopeType,
      scopeKey: scopeKey.trim() ? scopeKey.trim() : undefined,
      featureMetric
    },
    fetchPolicy: "network-only",
    skip: !enabled
  });

  const associations = assocData?.newsIndicatorAssociations ?? [];
  const assocErrorState = assocError
    ? buildRequestErrorEmptyState({ t, error: assocError, onRetry: () => refetchAssociations() })
    : null;
  const hasActiveFilters = Boolean(indicatorSlug || scopeType || featureMetric || scopeKey.trim());
  const clearFilters = () => {
    setIndicatorSlug(undefined);
    setScopeType(undefined);
    setFeatureMetric(undefined);
    setScopeKey("");
  };

  const {
    data: detailData,
    loading: detailLoading,
    error: detailError,
    refetch: refetchDetail
  } = useQuery<{
    newsIndicatorAssociation: AssociationDetails | null;
  }>(NEWS_INDICATOR_ASSOCIATION_QUERY, {
    variables: { id: selectedId ?? "", backtestsLimit: 25 },
    fetchPolicy: "network-only",
    skip: !selectedId
  });

  const detail = detailData?.newsIndicatorAssociation ?? null;

  const [refreshMutation, { loading: refreshing }] = useMutation<{ refreshNewsIndicatorAssociations: boolean }>(
    REFRESH_NEWS_INDICATOR_ASSOCIATIONS_MUTATION
  );

  const backtestSummaryLabels = useMemo(
    () => ({
      hitRate: t("pages.newsIndicator.backtestSummary.hitRate", { defaultValue: "Hit rate" }),
      avgSignedReturn: t("pages.newsIndicator.backtestSummary.avgSignedReturn", { defaultValue: "Avg" }),
      triggers: t("pages.newsIndicator.backtestSummary.triggers", { defaultValue: "Triggers" })
    }),
    [t]
  );

  const handleRefresh = async () => {
    try {
      await refreshMutation();
      await refetchAssociations();
      messageApi.success(t("pages.newsIndicator.refreshDone", { defaultValue: "Refresh triggered." }));
    } catch (err) {
      captureClientError("Failed to refresh news indicator associations", err);
      messageApi.error(t("pages.newsIndicator.refreshFailed", { defaultValue: "Refresh failed." }));
    }
  };

  const indicatorOptions = useMemo(() => {
    const slugs = settings?.indicatorSlugs ?? [];
    return slugs.map((slug) => ({ label: slug, value: slug }));
  }, [settings?.indicatorSlugs]);

  const columns = useMemo<ColumnsType<Association>>(
    () => [
      {
        title: t("pages.newsIndicator.columns.scope", { defaultValue: "Scope" }),
        dataIndex: "scopeKey",
        key: "scope",
        render: (_value: unknown, record) => (
          <Space wrap size={[6, 6]}>
            <Tag color={record.scopeType === "entity" ? "purple" : "blue"}>{getScopeTypeLabel(t, record.scopeType)}</Tag>
            {record.scopeKeyType ? <Tag>{record.scopeKeyType}</Tag> : null}
            <Typography.Text>{record.scopeKey}</Typography.Text>
          </Space>
        )
      },
      {
        title: t("pages.newsIndicator.columns.feature", { defaultValue: "Feature" }),
        dataIndex: "featureMetric",
        key: "featureMetric",
        render: (value: unknown) =>
          typeof value === "string" ? <Tag>{getFeatureMetricLabel(t, value as NewsIndicatorFeatureMetric)}</Tag> : <Tag>-</Tag>
      },
      {
        title: t("pages.newsIndicator.columns.indicator", { defaultValue: "Indicator" }),
        dataIndex: "indicator",
        key: "indicator",
        render: (value: EconomicDataItem) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>{value.displayName}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {value.slug}
              {value.defaultUnit ? ` · ${normalizeUnit(value.defaultUnit) ?? value.defaultUnit}` : ""}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: t("pages.newsIndicator.columns.lag", { defaultValue: "Lag" }),
        dataIndex: "lagDays",
        key: "lagDays",
        width: 90,
        render: (value: unknown) => <Typography.Text>{typeof value === "number" ? `${value}d` : "-"}</Typography.Text>
      },
      {
        title: t("pages.newsIndicator.columns.correlation", { defaultValue: "Corr" }),
        dataIndex: "correlation",
        key: "correlation",
        width: 110,
        render: (value: unknown) => {
          const numeric = typeof value === "number" ? value : Number.NaN;
          const color = numeric > 0 ? "green" : numeric < 0 ? "red" : undefined;
          return (
            <Typography.Text type={color === "red" ? "danger" : undefined}>
              <span style={color ? { color } : undefined}>{formatCorrelation(numeric)}</span>
            </Typography.Text>
          );
        }
      },
      {
        title: t("pages.newsIndicator.columns.pValue", { defaultValue: "p-value" }),
        dataIndex: "pValue",
        key: "pValue",
        width: 110,
        render: (value: unknown) => formatPValue(typeof value === "number" ? value : null)
      },
      {
        title: t("pages.newsIndicator.columns.samples", { defaultValue: "N" }),
        dataIndex: "sampleSize",
        key: "sampleSize",
        width: 90
      },
      {
        title: t("pages.newsIndicator.columns.backtest", { defaultValue: "Backtest" }),
        dataIndex: "latestBacktest",
        key: "latestBacktest",
        render: (_value: unknown, record) => {
          const run = record.latestBacktest;
          const summary = getBacktestSummary(run, backtestSummaryLabels);
          if (!run) {
            return <Typography.Text type="secondary">-</Typography.Text>;
          }
          return (
            <Space direction="vertical" size={0}>
              <Tag color={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "default"}>
                {getBacktestStatusLabel(t, run.status)}
              </Tag>
              {summary ? (
                <Tooltip title={summary}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {summary}
                  </Typography.Text>
                </Tooltip>
              ) : null}
            </Space>
          );
        }
      },
      {
        title: t("pages.newsIndicator.columns.updated", { defaultValue: "Updated" }),
        dataIndex: "lastEvaluatedAt",
        key: "lastEvaluatedAt",
        width: 140,
        render: (value: unknown) =>
          typeof value === "string"
            ? formatDateTime(value, locale, { year: "numeric", month: "2-digit", day: "2-digit" })
            : "-"
      },
      {
        title: t("common.actions", { defaultValue: "Actions" }),
        key: "actions",
        width: 110,
        render: (_value: unknown, record) => (
          <Button type="link" onClick={() => setSelectedId(record.id)}>
            {t("pages.newsIndicator.actions.details", { defaultValue: "Details" })}
          </Button>
        )
      }
    ],
    [backtestSummaryLabels, locale, t]
  );

  const scopeTypeOptions = useMemo(
    () => [
      { label: t("pages.newsIndicator.filters.scopeType.all", { defaultValue: "All" }), value: "all" },
      { label: t("pages.newsIndicator.filters.scopeType.entity", { defaultValue: "Entity" }), value: "entity" },
      { label: t("pages.newsIndicator.filters.scopeType.topic", { defaultValue: "Topic" }), value: "topic" }
    ],
    [t]
  );
  const featureMetricOptions = useMemo(
    () => [
      { label: t("pages.newsIndicator.filters.featureMetric.all", { defaultValue: "All" }), value: "all" },
      { label: t("pages.newsIndicator.filters.featureMetric.volume", { defaultValue: "Volume" }), value: "volume" },
      { label: t("pages.newsIndicator.filters.featureMetric.avgScore", { defaultValue: "Avg score" }), value: "avg_score" },
      { label: t("pages.newsIndicator.filters.featureMetric.negativeRatio", { defaultValue: "Negative ratio" }), value: "negative_ratio" }
    ],
    [t]
  );

  if (settingsLoading && !settings) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (settingsError) {
    const emptyState = buildRequestErrorEmptyState({
      t,
      error: settingsError,
      onRetry: () => refetchSettings()
    });
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant={emptyState.variant}
          title={emptyState.title}
          description={emptyState.description}
          actionLabel={emptyState.actionLabel}
          onAction={emptyState.onAction}
        />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="offline"
          title={t("pages.newsIndicator.disabledTitle", { defaultValue: "Disabled" })}
          description={t("pages.newsIndicator.disabledDescription", { defaultValue: "Disabled by admin." })}
          actionLabel={t("pages.newsIndicator.disabledCta", { defaultValue: "Open system settings" })}
          onAction={() =>
            router.push(
              buildAdminSettingsHref({
                page: "news",
                panel: "news-indicator",
              }),
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {contextHolder}

      <div className="flex flex-col gap-1">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.newsIndicator.title", { defaultValue: "News ↔ Indicators" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.newsIndicator.subtitle", {
            defaultValue: "Lead-lag correlations and backtests linking news signals to economic indicators."
          })}
        </Typography.Text>
      </div>

      {!ingestionEnabled ? (
        <ChartEmptyState
          className="mb-3"
          presentation="banner"
          variant="offline"
          title={t("pages.newsIndicator.ingestionOffTitle", { defaultValue: "Ingestion disabled" })}
          description={t("pages.newsIndicator.ingestionOffDescription", {
            defaultValue: "Scheduled refresh is disabled. You can still click Recompute to run once."
          })}
          actionLabel={t("pages.newsIndicator.ingestionOffCta", { defaultValue: "Open system settings" })}
          onAction={() =>
            router.push(
              buildAdminSettingsHref({
                page: "news",
                panel: "news-indicator",
              }),
            )
          }
        />
      ) : null}

      <Card className="content-card">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
            <Space wrap size="small">
              <Space size={6}>
                <Typography.Text type="secondary">{t("pages.newsIndicator.filters.indicator", { defaultValue: "Indicator" })}</Typography.Text>
                <Select
                  allowClear
                  placeholder={t("pages.newsIndicator.filters.indicatorPlaceholder", { defaultValue: "All" })}
                  value={indicatorSlug}
                  options={indicatorOptions}
                  onChange={(value) => setIndicatorSlug(value ?? undefined)}
                  style={{ minWidth: 200 }}
                />
              </Space>

              <Space size={6}>
                <Typography.Text type="secondary">{t("pages.newsIndicator.filters.scopeType.label", { defaultValue: "Scope" })}</Typography.Text>
                <Select
                  value={scopeType ?? "all"}
                  options={scopeTypeOptions}
                  onChange={(value) => setScopeType(value === "all" ? undefined : (value as NewsIndicatorScopeType))}
                  style={{ minWidth: 140 }}
                />
              </Space>

              <Space size={6}>
                <Typography.Text type="secondary">{t("pages.newsIndicator.filters.featureMetric.label", { defaultValue: "Feature" })}</Typography.Text>
                <Select
                  value={featureMetric ?? "all"}
                  options={featureMetricOptions}
                  onChange={(value) => setFeatureMetric(value === "all" ? undefined : (value as NewsIndicatorFeatureMetric))}
                  style={{ minWidth: 160 }}
                />
              </Space>

              <Input
                allowClear
                value={scopeKey}
                onChange={(evt) => setScopeKey(evt.target.value)}
                placeholder={t("pages.newsIndicator.filters.scopeKeyPlaceholder", { defaultValue: "Filter by scope key" })}
                style={{ width: 240 }}
              />

              <Select
                value={limit}
                onChange={(value) => setLimit(value)}
                options={[20, 50, 100, 200].map((value) => ({ value, label: String(value) }))}
                style={{ width: 100 }}
              />
            </Space>

            <Space>
              <Button onClick={() => refetchAssociations()} loading={assocLoading}>
                {t("common.refresh", { defaultValue: "Refresh" })}
              </Button>
              {canRefresh ? (
                <Button type="primary" onClick={handleRefresh} loading={refreshing}>
                  {t("pages.newsIndicator.actions.refresh", { defaultValue: "Recompute" })}
                </Button>
              ) : null}
            </Space>
          </div>

          {assocError && associations.length > 0 ? (
            <RequestErrorBanner
              className="mb-3"
              error={assocError}
              onRetry={() => void refetchAssociations()}
              showCachedDataHint
            />
          ) : null}

          {assocErrorState && associations.length === 0 ? (
            <div className="h-[260px]">
              <ChartEmptyState
                className="h-full"
                variant={assocErrorState.variant}
                title={assocErrorState.title}
                description={assocErrorState.description}
                actionLabel={assocErrorState.actionLabel}
                onAction={assocErrorState.onAction}
              />
            </div>
          ) : assocLoading && associations.length === 0 ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : associations.length === 0 ? (
            <ChartEmptyState
              className="h-[260px]"
              title={
                hasIndicatorSlugs
                  ? t("pages.newsIndicator.empty", { defaultValue: "No associations yet." })
                  : t("pages.newsIndicator.emptyNoIndicators", {
                      defaultValue: "No indicator slugs configured yet."
                    })
              }
              description={
                <div className="flex flex-col items-center gap-1">
                  <span>
                    {t("pages.newsIndicator.dataRequirements", {
                      defaultValue:
                        "Needs ≥ {{minSampleSize}} days of processed news (topics/entities/sentiment) and matching indicator data points (windowDays={{windowDays}}).",
                      minSampleSize,
                      windowDays
                    })}
                  </span>
                  {hasActiveFilters ? (
                    <span className="font-mono text-[10px] opacity-80">
                      {t("pages.newsIndicator.filters.activeHint", {
                        defaultValue: "Filters are active; try clearing them to broaden results."
                      })}
                    </span>
                  ) : null}
                </div>
              }
              action={
                <Space size="small" wrap>
                  {hasIndicatorSlugs && canRefresh ? (
                    <Button type="primary" onClick={handleRefresh} loading={refreshing}>
                      {t("pages.newsIndicator.actions.refresh", { defaultValue: "Recompute" })}
                    </Button>
                  ) : null}
                  <Button
                    type={hasIndicatorSlugs && canRefresh ? "default" : "primary"}
                    onClick={() =>
                      router.push(
                        buildAdminSettingsHref({
                          page: "news",
                          panel: "news-indicator",
                        }),
                      )
                    }
                  >
                    {t("pages.newsIndicator.emptyCta", { defaultValue: "Open system settings" })}
                  </Button>
                  {hasActiveFilters ? (
                    <Button
                      onClick={() => {
                        clearFilters();
                        void refetchAssociations();
                      }}
                    >
                      {t("pages.newsIndicator.filters.clear", { defaultValue: "Clear filters" })}
                    </Button>
                  ) : null}
                </Space>
              }
            />
          ) : (
            <Table
              rowKey={(row) => row.id}
              columns={columns}
              dataSource={associations}
              pagination={false}
              size="small"
            />
          )}
        </div>
      </Card>

      <Drawer
        open={selectedId !== null}
        width={860}
        destroyOnHidden
        onClose={() => setSelectedId(null)}
        title={t("pages.newsIndicator.drawer.title", { defaultValue: "Association details" })}
      >
        {detailLoading && !detail ? <Skeleton active paragraph={{ rows: 10 }} /> : null}

        {detailError ? (
          <RequestErrorBanner
            className="mb-3"
            error={detailError}
            onRetry={() => void refetchDetail()}
            showCachedDataHint={Boolean(detail)}
          />
        ) : null}

        {detail ? (
          <AssociationDetailsView locale={locale} association={detail} />
        ) : null}
      </Drawer>
    </div>
  );
}

function AssociationDetailsView({ association, locale }: { association: AssociationDetails; locale: SupportedLocale }) {
  const { t } = useTranslation();

  const indicator = association.indicator;
  const signLabel =
    association.correlation > 0
      ? t("pages.newsIndicator.correlationSign.positive", { defaultValue: "positive" })
      : t("pages.newsIndicator.correlationSign.negative", { defaultValue: "negative" });
  const backtests = association.backtests ?? [];
  const backtestSummaryLabels = useMemo(
    () => ({
      hitRate: t("pages.newsIndicator.backtestSummary.hitRate", { defaultValue: "Hit rate" }),
      avgSignedReturn: t("pages.newsIndicator.backtestSummary.avgSignedReturn", { defaultValue: "Avg" }),
      triggers: t("pages.newsIndicator.backtestSummary.triggers", { defaultValue: "Triggers" })
    }),
    [t]
  );

  return (
    <div className="flex flex-col gap-3">
      <Space direction="vertical" size={6}>
        <Space wrap size={[6, 6]}>
          <Tag color={association.scopeType === "entity" ? "purple" : "blue"}>{getScopeTypeLabel(t, association.scopeType)}</Tag>
          <Typography.Text strong>{association.scopeKey}</Typography.Text>
          {association.scopeKeyType ? <Tag>{association.scopeKeyType}</Tag> : null}
        </Space>
        <Space wrap size={[6, 6]}>
          <Tag>{getFeatureMetricLabel(t, association.featureMetric)}</Tag>
          <Tag color="geekblue">{indicator.slug}</Tag>
          {indicator.defaultUnit ? (
            <Tag>{normalizeUnit(indicator.defaultUnit) ?? indicator.defaultUnit}</Tag>
          ) : null}
          <Typography.Text>{indicator.displayName}</Typography.Text>
        </Space>
        <Space wrap size={[12, 0]}>
          <Typography.Text type="secondary">
            {t("pages.newsIndicator.drawer.correlation", { defaultValue: "Correlation" })}: {formatCorrelation(association.correlation)} ({signLabel})
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("pages.newsIndicator.drawer.pValue", { defaultValue: "p-value" })}: {formatPValue(association.pValue)}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("pages.newsIndicator.drawer.lag", { defaultValue: "Lag" })}: {association.lagDays}d
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("pages.newsIndicator.drawer.window", { defaultValue: "Window" })}: {association.windowDays}d
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("pages.newsIndicator.drawer.samples", { defaultValue: "Samples" })}: {association.sampleSize}
          </Typography.Text>
        </Space>
        <Space wrap size={[12, 0]}>
          <Typography.Text type="secondary">
            {t("pages.newsIndicator.drawer.analyzed", { defaultValue: "Analyzed" })}:{" "}
            {formatDateTime(association.analyzedStartAt, locale, { dateStyle: "medium" })} -{" "}
            {formatDateTime(association.analyzedEndAt, locale, { dateStyle: "medium" })}
          </Typography.Text>
        </Space>
      </Space>

      <Card size="small" className="content-card">
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {t("pages.newsIndicator.drawer.backtests", { defaultValue: "Backtests" })}
        </Typography.Title>
        {backtests.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("pages.newsIndicator.drawer.backtestsEmpty", { defaultValue: "No backtests yet." })}
          />
        ) : (
          <List
            dataSource={backtests}
            renderItem={(run) => {
              const summary = getBacktestSummary(run, backtestSummaryLabels);
              return (
                <List.Item key={run.id}>
                  <List.Item.Meta
                    title={
                      <Space wrap size={[6, 6]}>
                        <Tag color={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "default"}>
                          {getBacktestStatusLabel(t, run.status)}
                        </Tag>
                        <Typography.Text type="secondary">
                          {formatDateTime(run.windowStart, locale, { dateStyle: "medium" })} -{" "}
                          {formatDateTime(run.windowEnd, locale, { dateStyle: "medium" })}
                        </Typography.Text>
                        {summary ? <Tag>{summary}</Tag> : null}
                      </Space>
                    }
                    description={
                      run.error ? (
                        <Typography.Text type="danger">{run.error}</Typography.Text>
                      ) : run.metrics ? (
                        <pre className="text-xs whitespace-pre-wrap break-words bg-slate-50 border border-[var(--border)] rounded-md p-3">
                          {JSON.stringify(run.metrics, null, 2)}
                        </pre>
                      ) : (
                        <Typography.Text type="secondary">-</Typography.Text>
                      )
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    </div>
  );
}
