"use client";

import {
  ArrowLeftOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  List,
  Progress,
  Segmented,
  Skeleton,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import {
  useEntityIntelligenceCardQuery,
  useEntityIntelligenceEvidenceQuery,
} from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import {
  buildKnowledgeGraphExplorerHref,
  formatKnowledgeGraphLabel,
  normalizeKnowledgeGraphSeedType,
} from "@/lib/knowledge-graph-explorer";
import { SENTIMENT_COLORS } from "@/lib/status-tokens";
import { safeHttpUrl } from "@/lib/url";

interface EntityIntelligenceCardProps {
  entityId: string;
}

const { Paragraph, Text, Title } = Typography;

const WINDOW_OPTIONS = [
  { label: "7D", value: 7 },
  { label: "30D", value: 30 },
  { label: "90D", value: 90 },
];

function clampWindowDays(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return 30;
  }
  if (parsed <= 7) {
    return 7;
  }
  if (parsed <= 30) {
    return 30;
  }
  return 90;
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${Math.round(value * 100)}%`;
}

function formatScore(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(2);
}

function getSentimentColor(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return SENTIMENT_COLORS.neutral;
  }
  if (value > 0.1) {
    return SENTIMENT_COLORS.positive;
  }
  if (value < -0.1) {
    return SENTIMENT_COLORS.negative;
  }
  return SENTIMENT_COLORS.gray;
}

export function EntityIntelligenceCard({
  entityId,
}: EntityIntelligenceCardProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status: sessionStatus } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const authenticated = sessionStatus === "authenticated";
  const canReadDashboards = permissions.includes("dashboards.read");

  const windowDays = clampWindowDays(searchParams.get("windowDays"));
  const variables = useMemo(
    () => ({
      input: {
        entityId,
        windowDays,
        relatedLimit: 12,
      },
    }),
    [entityId, windowDays],
  );
  const evidenceVariables = useMemo(
    () => ({
      input: {
        entityId,
        windowDays,
        eventsLimit: 10,
        evidenceLimit: 12,
      },
    }),
    [entityId, windowDays],
  );

  const {
    data,
    loading,
    error,
    refetch: refetchCard,
  } = useEntityIntelligenceCardQuery({
    variables,
    fetchPolicy: "cache-and-network",
    skip: !authenticated || !canReadDashboards,
  });
  const {
    data: evidenceData,
    loading: evidenceLoading,
    error: evidenceError,
    refetch: refetchEvidence,
  } = useEntityIntelligenceEvidenceQuery({
    variables: evidenceVariables,
    fetchPolicy: "cache-and-network",
    skip: !authenticated || !canReadDashboards,
  });

  const card = data?.entityIntelligenceCard ?? null;
  const evidence = evidenceData?.entityIntelligenceEvidence ?? null;

  const explorerHref = card
    ? buildKnowledgeGraphExplorerHref({
        seedName: card.entity.name,
        seedType: normalizeKnowledgeGraphSeedType(card.entity.type),
      })
    : "/knowledge-graph";
  const searchHref = card
    ? `/search?q=${encodeURIComponent(card.entity.name)}`
    : "/search";

  const handleWindowChange = (value: number | string) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("windowDays", String(value));
    router.replace(`/entities/${encodeURIComponent(entityId)}?${nextParams.toString()}`, {
      scroll: false,
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("common.copyFailed"));
    }
  };

  if (sessionStatus === "loading") {
    return <Skeleton active paragraph={{ rows: 12 }} />;
  }

  if (!authenticated || !canReadDashboards) {
    return (
      <ChartEmptyState
        variant="permission"
        title={t("common.accessDenied")}
        description={t("common.accessDeniedDescription")}
      />
    );
  }

  if (loading && !card) {
    return <Skeleton active paragraph={{ rows: 14 }} />;
  }

  if (error && !card) {
    return (
      <ChartEmptyState
        variant="error"
        title={t("dashboard.dataAbnormal")}
        description={error.message}
        actionLabel={t("dashboard.actions.retryFetch")}
        onAction={() => {
          void refetchCard();
        }}
      />
    );
  }

  if (!card) {
    return (
      <ChartEmptyState
        title={t("pages.knowledgeGraph.notFoundTitle")}
        description={t("pages.knowledgeGraph.notFoundDescription")}
      />
    );
  }

  const sentimentProgress = Math.max(
    0,
    Math.min(100, ((card.metrics.avgSentiment ?? 0) + 1) * 50),
  );

  return (
    <Space direction="vertical" size="large" className="w-full">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <Space direction="vertical" size={8} className="min-w-0">
          <Link href="/knowledge-graph" className="inline-flex items-center gap-2 text-sm">
            <ArrowLeftOutlined />
            {t("nav.main.knowledgeGraph")}
          </Link>
          <div>
            <Space wrap align="center">
              <Title level={3} style={{ margin: 0 }}>
                {card.entity.name}
              </Title>
              <Tag color="blue">
                {t(`pages.knowledgeGraph.nodeTypes.${card.entity.type}`, {
                  defaultValue: formatKnowledgeGraphLabel(card.entity.type),
                })}
              </Tag>
            </Space>
            <Text type="secondary">
              {t("entities.intelligence.generatedAt")}{" "}
              {dayjs(card.generatedAt).format("YYYY-MM-DD HH:mm")}
            </Text>
          </div>
          {card.aliases.length > 0 ? (
            <Space wrap>
              {card.aliases.slice(0, 8).map((alias) => (
                <Tag key={alias}>{alias}</Tag>
              ))}
            </Space>
          ) : null}
        </Space>
        <Space wrap>
          <Segmented
            value={windowDays}
            options={WINDOW_OPTIONS}
            onChange={handleWindowChange}
          />
          <Button icon={<SearchOutlined />} href={searchHref}>
            {t("pages.knowledgeGraph.actions.openSearch")}
          </Button>
          <Button icon={<ShareAltOutlined />} href={explorerHref}>
            {t("pages.knowledgeGraph.actions.openExplorer")}
          </Button>
          <Button icon={<CopyOutlined />} onClick={() => void copyLink()}>
            {t("common.copy")}
          </Button>
          <Tooltip title={t("dashboard.actions.retryFetch")}>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void Promise.all([refetchCard(), refetchEvidence()]);
              }}
            />
          </Tooltip>
        </Space>
      </div>

      {error ? (
        <RequestErrorBanner
          error={error}
          onRetry={() => {
            void refetchCard();
          }}
          showCachedDataHint
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <Statistic
            title={t("entities.intelligence.relationships")}
            value={card.metrics.relationshipCount}
          />
        </Card>
        <Card>
          <Statistic
            title={t("entities.intelligence.mentions")}
            value={card.metrics.mentionedArticleCount}
          />
        </Card>
        <Card>
          <Statistic
            title={t("entities.intelligence.events")}
            value={card.metrics.recentEventCount}
          />
        </Card>
        <Card>
          <Statistic
            title={t("entities.intelligence.negativeRatio")}
            value={formatPercent(card.metrics.negativeRatio)}
          />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <Space direction="vertical" size="large" className="w-full">
          <Card
            title={t("entities.intelligence.neighborhood")}
          >
            <div className="flex flex-wrap gap-3">
              {card.neighborhood.nodes.map((node) => {
                const isSeed = node.id === card.entity.id;
                return (
                  <Link
                    key={node.id}
                    href={`/entities/${encodeURIComponent(node.id)}`}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      isSeed
                        ? "border-blue-500 bg-blue-50 text-blue-900"
                        : "border-slate-200 bg-white text-slate-700"
                    }`}
                  >
                    <Text strong={isSeed}>{node.name}</Text>
                    <Text type="secondary" className="ml-2 text-xs">
                      {formatKnowledgeGraphLabel(node.type)}
                    </Text>
                  </Link>
                );
              })}
            </div>
          </Card>

          <Card
            title={t("entities.intelligence.relationships")}
          >
            <List
              dataSource={card.relationships}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t("dashboard.charts.entityGraph.noRelatedEntities")}
                  />
                ),
              }}
              renderItem={(relationship) => (
                <List.Item
                  actions={[
                    <Link
                      key="open"
                      href={`/entities/${encodeURIComponent(relationship.neighbor.id)}`}
                    >
                      <LinkOutlined />
                    </Link>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Text strong>{relationship.neighbor.name}</Text>
                        <Tag>{formatKnowledgeGraphLabel(relationship.edge.type)}</Tag>
                        <Tag color={relationship.direction === "outgoing" ? "blue" : "purple"}>
                          {relationship.direction}
                        </Tag>
                      </Space>
                    }
                    description={
                      <Space wrap>
                        <Text type="secondary">
                          {t("pages.knowledgeGraph.details.confidence")}
                          : {relationship.edge.confidence.toFixed(2)}
                        </Text>
                        <Text type="secondary">
                          {t("pages.knowledgeGraph.details.weight")}
                          : {relationship.edge.weight.toFixed(2)}
                        </Text>
                        <Text type="secondary">
                          {t("pages.knowledgeGraph.details.evidenceTitle")}
                          : {relationship.evidenceCount}
                        </Text>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Space>

        <Space direction="vertical" size="large" className="w-full">
          <Card
            title={t("entities.intelligence.sentiment")}
          >
            <Space direction="vertical" className="w-full">
              <Descriptions size="small" column={1}>
                <Descriptions.Item
                  label={t("entities.intelligence.avgSentiment")}
                >
                  <Text style={{ color: getSentimentColor(card.metrics.avgSentiment) }}>
                    {formatScore(card.metrics.avgSentiment)}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item
                  label={t("entities.intelligence.negativeRatio")}
                >
                  {formatPercent(card.metrics.negativeRatio)}
                </Descriptions.Item>
              </Descriptions>
              <Progress
                percent={sentimentProgress}
                showInfo={false}
                strokeColor={getSentimentColor(card.metrics.avgSentiment)}
              />
              <div className="flex h-20 items-end gap-1">
                {card.sentimentSeries.map((point) => {
                  const height = Math.max(6, Math.min(72, Math.abs(point.avgScore) * 72));
                  return (
                    <Tooltip
                      key={`${point.entityName}-${point.bucketStart}`}
                      title={`${dayjs(point.bucketStart).format("MM-DD")} · ${point.avgScore.toFixed(2)}`}
                    >
                      <div
                        className="w-2 rounded-sm"
                        style={{
                          height,
                          background: getSentimentColor(point.avgScore),
                        }}
                      />
                    </Tooltip>
                  );
                })}
              </div>
            </Space>
          </Card>

          <Card
            title={t("entities.intelligence.evidence")}
            loading={evidenceLoading && !evidence}
          >
            {evidenceError ? (
              <RequestErrorBanner
                error={evidenceError}
                onRetry={() => {
                  void refetchEvidence();
                }}
                showCachedDataHint
              />
            ) : evidence?.restricted ? (
              <Alert
                type="warning"
                showIcon
                message={t("pages.knowledgeGraph.details.evidencePermissionTitle")}
              />
            ) : (
              <Space direction="vertical" className="w-full">
                <List
                  header={
                    <Text strong>
                      {t("entities.intelligence.events")}
                    </Text>
                  }
                  dataSource={evidence?.events ?? []}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                  renderItem={(event) => (
                    <List.Item>
                      <List.Item.Meta
                        title={<Link href={`/events/${event.id}`}>{event.title ?? event.id}</Link>}
                        description={
                          <Space direction="vertical" size={2}>
                            <Text type="secondary">
                              {dayjs(event.lastAt).format("YYYY-MM-DD HH:mm")} · {event.itemCount}
                            </Text>
                            {event.summary ? (
                              <Paragraph ellipsis={{ rows: 2 }} className="!mb-0">
                                {event.summary}
                              </Paragraph>
                            ) : null}
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
                <List
                  header={
                    <Text strong>
                      {t("entities.intelligence.articles")}
                    </Text>
                  }
                  dataSource={evidence?.articles ?? []}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                  renderItem={(entry) => {
                    const href = safeHttpUrl(entry.article.url);
                    return (
                      <List.Item>
                        <List.Item.Meta
                          title={
                            href ? (
                              <a href={href} target="_blank" rel="noreferrer">
                                {entry.article.title ?? entry.article.url}
                              </a>
                            ) : (
                              (entry.article.title ?? entry.article.id)
                            )
                          }
                          description={
                            <Space direction="vertical" size={2}>
                              <Text type="secondary">
                                {entry.article.sourceLabel ?? "-"} ·{" "}
                                {dayjs(entry.article.crawlAt).format("YYYY-MM-DD HH:mm")}
                              </Text>
                              {entry.article.summary ? (
                                <Paragraph ellipsis={{ rows: 2 }} className="!mb-0">
                                  {entry.article.summary}
                                </Paragraph>
                              ) : null}
                            </Space>
                          }
                        />
                      </List.Item>
                    );
                  }}
                />
              </Space>
            )}
          </Card>
        </Space>
      </div>
    </Space>
  );
}
