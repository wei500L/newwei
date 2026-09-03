"use client";

import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Empty,
  Input,
  List,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
} from "antd";
import { useRouter } from "next/navigation";
import { useMemo, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { emitSituationMonitorMonitorsUpdated } from "@/app/(app)/situation-monitor/utils/monitor-events";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import {
  type ContentSubscriptionBatchResponse,
  type ContentSubscriptionCatalogItem,
  type ContentSubscriptionCatalogResponse,
  type ContentSubscriptionItem,
  type ContentSubscriptionKind,
  type ContentSubscriptionListResponse,
  buildContentSubscriptionKey,
} from "@/lib/content-subscriptions";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { trackUserNewsBehavior } from "@/lib/user-news-behavior";

interface ContentSubscriptionsTabProps {
  accessToken?: string;
  active: boolean;
}

interface SubscriptionFeedbackState {
  message: string;
  description: string;
}

const DATE_TIME_FORMAT = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
} as const;
const UNCATEGORIZED_TAXONOMY_FILTER = "__uncategorized__";
const CONTENT_SUBSCRIPTION_KIND_ORDER: ContentSubscriptionKind[] = [
  "topic",
  "entity",
  "source",
  "keyword",
  "geo",
];

interface GroupedItems<
  T extends {
    kind: ContentSubscriptionKind;
    taxonomyPath: string | null;
    taxonomyDisplayName: string | null;
    taxonomyLabels: string[];
  },
> {
  groupKey: string;
  title: string;
  labels: string[];
  items: T[];
}

function getContentSubscriptionKindLabel(
  kind: ContentSubscriptionKind,
  t: ReturnType<typeof useTranslation>["t"],
) {
  switch (kind) {
    case "topic":
      return t("subscriptions.content.kindTopics");
    case "entity":
      return t("subscriptions.content.kindEntities");
    case "source":
      return t("subscriptions.content.kindSources");
    case "keyword":
      return t("subscriptions.content.kindKeywords");
    case "geo":
      return t("subscriptions.content.kindGeos");
  }
}

function getContentSubscriptionKindColor(kind: ContentSubscriptionKind) {
  switch (kind) {
    case "topic":
      return "blue";
    case "entity":
      return "purple";
    case "source":
      return "gold";
    case "keyword":
      return "green";
    case "geo":
      return "cyan";
  }
}

function parseKeywordEntries(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ).slice(0, 10);
}

function toMetadataRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildSubscriptionSearchText(item: ContentSubscriptionItem) {
  const metadata = toMetadataRecord(item.metadata);
  return [
    item.displayValue,
    item.normalizedValue,
    item.taxonomyDisplayName ?? "",
    ...(item.taxonomyLabels ?? []),
    typeof metadata?.sourceId === "string" ? metadata.sourceId : "",
    typeof metadata?.language === "string" ? metadata.language : "",
    typeof metadata?.countryCodeAlpha2 === "string"
      ? metadata.countryCodeAlpha2
      : "",
  ]
    .join(" ")
    .toLowerCase();
}

export function ContentSubscriptionsTab({
  accessToken,
  active,
}: ContentSubscriptionsTabProps) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const [loading, setLoading] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [subscriptions, setSubscriptions] =
    useState<ContentSubscriptionListResponse | null>(null);
  const [catalog, setCatalog] =
    useState<ContentSubscriptionCatalogResponse | null>(null);
  const [recommendations, setRecommendations] =
    useState<ContentSubscriptionCatalogResponse | null>(null);
  const [subscriptionQuery, setSubscriptionQuery] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [addingKeywords, setAddingKeywords] = useState(false);
  const [catalogInput, setCatalogInput] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogKind, setCatalogKind] = useState<
    "all" | ContentSubscriptionKind
  >("all");
  const [taxonomyFilter, setTaxonomyFilter] = useState<string | null>(null);
  const [subscriptionRefreshWarning, setSubscriptionRefreshWarning] =
    useState<SubscriptionFeedbackState | null>(null);
  const [recommendationsWarning, setRecommendationsWarning] =
    useState<SubscriptionFeedbackState | null>(null);
  const [selectedSubscriptionKeys, setSelectedSubscriptionKeys] = useState<
    string[]
  >([]);
  const [selectedCatalogKeys, setSelectedCatalogKeys] = useState<string[]>([]);

  const loadSubscriptions = useCallback(async () => {
    const response = await apiClient.get<ContentSubscriptionListResponse>(
      "user-content-subscriptions",
    );
    setSubscriptions(response.data ?? null);
  }, [apiClient]);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const params = new URLSearchParams();
      if (catalogKind !== "all") {
        params.set("kind", catalogKind);
      }
      if (catalogQuery.trim()) {
        params.set("query", catalogQuery.trim());
      }
      if (taxonomyFilter === UNCATEGORIZED_TAXONOMY_FILTER) {
        params.set("taxonomyPath", UNCATEGORIZED_TAXONOMY_FILTER);
      } else if (taxonomyFilter) {
        params.set("taxonomyPath", taxonomyFilter);
      }
      params.set("limit", "200");
      const response = await apiClient.get<ContentSubscriptionCatalogResponse>(
        `user-content-subscriptions/catalog${params.toString() ? `?${params.toString()}` : ""}`,
      );
      setCatalog(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to load content subscription catalog", error);
      message.error(
        t("subscriptions.content.catalogLoadFailed"),
      );
    } finally {
      setLoadingCatalog(false);
    }
  }, [apiClient, catalogKind, catalogQuery, message, t, taxonomyFilter]);

  const loadRecommendations = useCallback(async () => {
    try {
      const response = await apiClient.get<ContentSubscriptionCatalogResponse>(
        "user-content-subscriptions/recommendations?limit=12",
      );
      setRecommendations(response.data ?? null);
      setRecommendationsWarning(null);
    } catch (error) {
      captureClientError(
        "Failed to load content subscription recommendations",
        error,
      );
      setRecommendationsWarning({
        message: t("subscriptions.content.recommendationsLoadFailed"),
        description: t(
          "subscriptions.content.recommendationsLoadFailedDescription",
        ),
      });
      message.warning(
        t("subscriptions.content.recommendationsLoadFailed"),
      );
    }
  }, [apiClient, message, t]);

  const refreshSubscriptionViews = useCallback(async () => {
    const [subscriptionsResult] = await Promise.allSettled([
      loadSubscriptions(),
      loadRecommendations(),
      loadCatalog(),
    ]);

    if (subscriptionsResult.status === "rejected") {
      captureClientError(
        "Failed to refresh content subscriptions after mutation",
        subscriptionsResult.reason,
      );
      setSubscriptionRefreshWarning({
        message: t("subscriptions.content.refreshFailedAfterMutation"),
        description: t(
          "subscriptions.content.refreshFailedAfterMutationDescription",
        ),
      });
      message.warning(
        t("subscriptions.content.refreshFailedAfterMutation"),
      );
      return false;
    }

    setSubscriptionRefreshWarning(null);
    return true;
  }, [loadCatalog, loadRecommendations, loadSubscriptions, message, t]);

  const loadAll = useCallback(async () => {
    if (!accessToken) {
      return;
    }
    setLoading(true);
    try {
      const [subscriptionsResult] = await Promise.allSettled([
        loadSubscriptions(),
        loadRecommendations(),
      ]);

      if (subscriptionsResult.status === "rejected") {
        captureClientError(
          "Failed to load content subscriptions center",
          subscriptionsResult.reason,
        );
        setSubscriptionRefreshWarning({
          message: t("subscriptions.content.loadFailed"),
          description: t("subscriptions.content.loadFailedDescription"),
        });
        message.error(
          t("subscriptions.content.loadFailed"),
        );
      } else {
        setSubscriptionRefreshWarning(null);
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, loadRecommendations, loadSubscriptions, message, t]);

  useEffect(() => {
    if (!active || !accessToken) {
      return;
    }
    void loadAll();
  }, [accessToken, active, loadAll]);

  useEffect(() => {
    if (!active || !accessToken || !subscriptions) {
      return;
    }
    void loadCatalog();
  }, [
    accessToken,
    active,
    catalogKind,
    catalogQuery,
    loadCatalog,
    subscriptions,
    taxonomyFilter,
  ]);

  const subscribedKeys = useMemo(() => {
    return new Set(
      (subscriptions?.items ?? []).map((item) =>
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
  }, [subscriptions?.items]);

  const filteredSubscriptions = useMemo(() => {
    const query = subscriptionQuery.trim().toLowerCase();
    if (!query) {
      return subscriptions?.items ?? [];
    }
    return (subscriptions?.items ?? []).filter((item) =>
      buildSubscriptionSearchText(item).includes(query),
    );
  }, [subscriptionQuery, subscriptions?.items]);

  const subscriptionGroups = useMemo(
    () => groupByTaxonomy(filteredSubscriptions),
    [filteredSubscriptions],
  );
  const catalogGroups = useMemo(
    () => groupByTaxonomy(catalog?.items ?? []),
    [catalog?.items],
  );
  const taxonomyOptions = useMemo(() => {
    const groups = groupByTaxonomy(catalog?.items ?? []);
    return groups.map((group) => ({
      value: group.groupKey,
      label: `${group.title} (${group.items.length})`,
    }));
  }, [catalog?.items]);

  const selectedSubscriptionItems = useMemo(() => {
    const selected = new Set(selectedSubscriptionKeys);
    return filteredSubscriptions.filter((item) =>
      selected.has(
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
  }, [filteredSubscriptions, selectedSubscriptionKeys]);

  const removableSelectedSubscriptionItems = useMemo(() => {
    return selectedSubscriptionItems.filter((item) => !item.manualMonitorOwned);
  }, [selectedSubscriptionItems]);

  const selectedCatalogItems = useMemo(() => {
    const selected = new Set(selectedCatalogKeys);
    return (catalog?.items ?? []).filter((item) =>
      selected.has(
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
  }, [catalog?.items, selectedCatalogKeys]);

  const trackSubscriptionRemoval = useCallback(
    (
      item: Pick<
        ContentSubscriptionItem,
        "kind" | "displayValue" | "normalizedValue"
      >,
    ) => {
      if (item.kind === "topic") {
        void trackUserNewsBehavior({
          type: "unsubscribe",
          topics: [item.displayValue],
        });
        return;
      }
      if (item.kind === "entity") {
        void trackUserNewsBehavior({
          type: "unsubscribe",
          entities: [item.displayValue],
        });
        return;
      }
      if (item.kind === "source") {
        void trackUserNewsBehavior({
          type: "not_interested",
          source: item.normalizedValue,
        });
      }
    },
    [],
  );

  const renderMetadata = useCallback(
    (item: { kind: ContentSubscriptionKind; metadata?: unknown }) => {
      const metadata = toMetadataRecord(item.metadata);
      if (!metadata) {
        return null;
      }

      const tags: { key: string; label: string }[] = [];
      if (item.kind === "source") {
        if (typeof metadata.sourceId === "string") {
          tags.push({
            key: "sourceId",
            label: t("subscriptions.content.metadataSourceId", {
              value: metadata.sourceId,
            }),
          });
        }
        if (typeof metadata.language === "string") {
          tags.push({
            key: "language",
            label: t("subscriptions.content.metadataLanguage", {
              value: metadata.language,
            }),
          });
        }
      }
      if (
        item.kind === "geo" &&
        typeof metadata.countryCodeAlpha2 === "string"
      ) {
        tags.push({
          key: "country",
          label: t("subscriptions.content.metadataCountry", {
            value: metadata.countryCodeAlpha2,
          }),
        });
      }

      const links: { key: string; label: string }[] = [];
      if (item.kind === "source" && typeof metadata.siteUrl === "string") {
        links.push({
          key: "siteUrl",
          label: t("subscriptions.content.metadataSite", {
            value: metadata.siteUrl,
          }),
        });
      }
      if (item.kind === "source" && typeof metadata.feedUrl === "string") {
        links.push({
          key: "feedUrl",
          label: t("subscriptions.content.metadataFeed", {
            value: metadata.feedUrl,
          }),
        });
      }

      if (tags.length === 0 && links.length === 0) {
        return null;
      }

      return (
        <Space direction="vertical" size={4}>
          {tags.length > 0 ? (
            <Space wrap size={[4, 4]}>
              {tags.map((entry) => (
                <Tag key={`${item.kind}:${entry.key}`}>{entry.label}</Tag>
              ))}
            </Space>
          ) : null}
          {links.length > 0 ? (
            <Space direction="vertical" size={0}>
              {links.map((entry) => (
                <Typography.Text
                  key={`${item.kind}:${entry.key}`}
                  type="secondary"
                >
                  {entry.label}
                </Typography.Text>
              ))}
            </Space>
          ) : null}
        </Space>
      );
    },
    [t],
  );

  useEffect(() => {
    const availableKeys = new Set(
      filteredSubscriptions.map((item) =>
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
    setSelectedSubscriptionKeys((current) =>
      current.filter((entry) => availableKeys.has(entry)),
    );
  }, [filteredSubscriptions]);

  useEffect(() => {
    const availableKeys = new Set(
      (catalog?.items ?? []).map((item) =>
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
    setSelectedCatalogKeys((current) =>
      current.filter((entry) => availableKeys.has(entry)),
    );
  }, [catalog?.items]);

  const handleBatchRemove = useCallback(async () => {
    if (removableSelectedSubscriptionItems.length === 0) {
      if (selectedSubscriptionItems.some((item) => item.manualMonitorOwned)) {
        message.info(
          t("subscriptions.content.monitorOwnedRemoveBlocked"),
        );
      }
      return;
    }
    try {
      await apiClient.post<ContentSubscriptionBatchResponse>(
        "user-content-subscriptions/batch-delete",
        {
          subscriptions: removableSelectedSubscriptionItems.map((item) => ({
            kind: item.kind,
            value: item.normalizedValue,
          })),
        },
      );
      removableSelectedSubscriptionItems.forEach((item) =>
        trackSubscriptionRemoval(item),
      );
      message.success(
        t("subscriptions.content.batchRemoved"),
      );
      setSelectedSubscriptionKeys([]);
      await refreshSubscriptionViews();
      emitSituationMonitorMonitorsUpdated("subscriptions");
    } catch (error) {
      captureClientError("Failed to remove content subscriptions", error);
      message.error(
        t("subscriptions.content.batchRemoveFailed"),
      );
    }
  }, [
    apiClient,
    refreshSubscriptionViews,
    message,
    removableSelectedSubscriptionItems,
    selectedSubscriptionItems,
    t,
    trackSubscriptionRemoval,
  ]);

  const openOwnerMonitor = useCallback(
    (item: ContentSubscriptionItem) => {
      const monitorId = item.ownerMonitorIds?.[0];
      if (!monitorId) {
        router.push("/situation-monitor");
        return;
      }
      router.push(
        `/situation-monitor?monitorId=${encodeURIComponent(monitorId)}`,
      );
    },
    [router],
  );

  const handleBatchSubscribe = async (
    items: ContentSubscriptionCatalogItem[],
    source: "recommendation" | "manual" = "manual",
  ) => {
    if (items.length === 0) {
      return;
    }
    try {
      const response = await apiClient.post<ContentSubscriptionBatchResponse>(
        "user-content-subscriptions/batch-upsert",
        {
          subscriptions: items.map((item) => ({
            kind: item.kind,
            value: item.normalizedValue,
            source,
          })),
        },
      );
      const subscribedCount = (response.data?.items ?? []).filter(
        (item) => item.status === "subscribed",
      ).length;
      const limitReached = (response.data?.items ?? []).some(
        (item) => item.status === "limit_reached",
      );
      if (subscribedCount > 0) {
        message.success(
          t("subscriptions.content.batchAdded", {
            count: subscribedCount,
          }),
        );
      } else if (limitReached) {
        message.warning(
          t("subscriptions.content.limitReached"),
        );
      } else {
        message.info(
          t("subscriptions.content.noChanges"),
        );
      }
      setSelectedCatalogKeys([]);
      await refreshSubscriptionViews();
      if (subscribedCount > 0) {
        emitSituationMonitorMonitorsUpdated("subscriptions");
      }
    } catch (error) {
      captureClientError("Failed to add content subscriptions", error);
      message.error(
        t("subscriptions.content.batchAddFailed"),
      );
    }
  };

  const handleAddKeywords = useCallback(
    async (value: string) => {
      const keywords = parseKeywordEntries(value);
      if (keywords.length === 0) {
        return;
      }

      setAddingKeywords(true);
      try {
        const response = await apiClient.post<ContentSubscriptionBatchResponse>(
          "user-content-subscriptions/batch-upsert",
          {
            subscriptions: keywords.map((keyword) => ({
              kind: "keyword",
              value: keyword,
              source: "manual",
            })),
          },
        );
        const subscribedCount = (response.data?.items ?? []).filter(
          (item) => item.status === "subscribed",
        ).length;
        const limitReached = (response.data?.items ?? []).some(
          (item) => item.status === "limit_reached",
        );

        if (subscribedCount > 0) {
          message.success(
            t("subscriptions.content.keywordsAdded", {
              count: subscribedCount,
            }),
          );
          setKeywordInput("");
        } else if (limitReached) {
          message.warning(
            t("subscriptions.content.limitReached"),
          );
        } else {
          message.info(
            t("subscriptions.content.noChanges"),
          );
        }

        await refreshSubscriptionViews();
        if (subscribedCount > 0) {
          emitSituationMonitorMonitorsUpdated("subscriptions");
        }
      } catch (error) {
        captureClientError("Failed to add keyword subscriptions", error);
        message.error(
          t("subscriptions.content.keywordAddFailed"),
        );
      } finally {
        setAddingKeywords(false);
      }
    },
    [apiClient, message, refreshSubscriptionViews, t],
  );

  if (!accessToken) {
    return (
      <ChartEmptyState
        variant="permission"
        title={t("common.accessDenied")}
        description={t("subscriptions.content.signInRequired")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        className="content-card"
        extra={
          <Button size="small" onClick={() => void loadAll()}>
            {t("common.refresh")}
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("subscriptions.content.summary")}
          </Typography.Text>
          <Space wrap size={[8, 8]}>
            {CONTENT_SUBSCRIPTION_KIND_ORDER.map((kind) => (
              <Tag key={kind} color={getContentSubscriptionKindColor(kind)}>
                {t(`subscriptions.content.${kind}Count`, {
                  defaultValue: `${getContentSubscriptionKindLabel(kind, t)}: {{count}}`,
                  count: subscriptions?.counts[kind] ?? 0,
                })}
              </Tag>
            ))}
            <Tag>
              {t("subscriptions.content.limitLabel", {
                count: subscriptions?.limitPerKind ?? 50,
              })}
            </Tag>
          </Space>
        </Space>
      </Card>

      {subscriptionRefreshWarning ? (
        <Alert
          showIcon
          closable
          type="warning"
          message={subscriptionRefreshWarning.message}
          description={subscriptionRefreshWarning.description}
          onClose={() => setSubscriptionRefreshWarning(null)}
          action={
            <Button size="small" onClick={() => void loadAll()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}

      <Card
        className="content-card"
        title={t("subscriptions.content.currentTitle")}
        extra={
          <Space size="small">
            <Input.Search
              allowClear
              value={subscriptionQuery}
              onChange={(event) => setSubscriptionQuery(event.target.value)}
              placeholder={t("subscriptions.content.searchPlaceholder")}
              style={{ width: 260 }}
            />
            <Button
              danger
              disabled={removableSelectedSubscriptionItems.length === 0}
              onClick={() => void handleBatchRemove()}
            >
              {t("subscriptions.content.batchUnsubscribe")}
            </Button>
          </Space>
        }
      >
        {loading && !subscriptions ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : subscriptionGroups.length === 0 ? (
          <Empty
            description={t("subscriptions.content.currentEmpty")}
          />
        ) : (
          <Collapse
            items={subscriptionGroups.map((group) => ({
              key: group.groupKey,
              label: `${group.title} (${group.items.length})`,
              children: (
                <List
                  dataSource={group.items}
                  renderItem={(item) => (
                    <List.Item
                      actions={[
                        item.manualMonitorOwned ? (
                          <Button
                            key="open-monitor"
                            type="link"
                            onClick={() => openOwnerMonitor(item)}
                          >
                            {t("subscriptions.content.openMonitor")}
                          </Button>
                        ) : (
                          <Button
                            key="remove"
                            type="link"
                            danger
                            onClick={() => void handleBatchRemoveSingle(item)}
                          >
                            {t("common.remove")}
                          </Button>
                        ),
                      ]}
                    >
                      <Space
                        align="start"
                        size="middle"
                        style={{
                          width: "100%",
                          justifyContent: "space-between",
                        }}
                      >
                        <Checkbox
                          disabled={item.manualMonitorOwned}
                          checked={selectedSubscriptionKeys.includes(
                            buildContentSubscriptionKey(
                              item.kind,
                              item.normalizedValue,
                            ),
                          )}
                          onChange={(event) => {
                            const key = buildContentSubscriptionKey(
                              item.kind,
                              item.normalizedValue,
                            );
                            setSelectedSubscriptionKeys((current) =>
                              event.target.checked
                                ? Array.from(new Set([...current, key]))
                                : current.filter((entry) => entry !== key),
                            );
                          }}
                        />
                        <Space
                          direction="vertical"
                          size={4}
                          style={{ flex: 1 }}
                        >
                          <Space wrap size={[6, 6]}>
                            <Typography.Text strong>
                              {item.displayValue}
                            </Typography.Text>
                            <Tag
                              color={getContentSubscriptionKindColor(item.kind)}
                            >
                              {getContentSubscriptionKindLabel(item.kind, t)}
                            </Tag>
                            {item.taxonomyDisplayName ? (
                              <Tag>{item.taxonomyDisplayName}</Tag>
                            ) : null}
                            {item.manualMonitorOwned
                              ? (item.ownerMonitorNames ?? []).map(
                                  (name, index) => (
                                    <Tag
                                      key={`${item.id}:owner:${name}:${index}`}
                                      color="gold"
                                      className="cursor-pointer"
                                      onClick={() => openOwnerMonitor(item)}
                                    >
                                      {name}
                                    </Tag>
                                  ),
                                )
                              : null}
                            {!item.manualMonitorOwned &&
                            item.systemSyncOwned ? (
                              <Tag color="purple">
                                {t("situationMonitor.monitors.systemSync")}
                              </Tag>
                            ) : null}
                          </Space>
                          {item.taxonomyLabels.length > 0 ? (
                            <Space wrap size={[4, 4]}>
                              {item.taxonomyLabels.map((label) => (
                                <Tag key={`${item.id}-${label}`}>{label}</Tag>
                              ))}
                            </Space>
                          ) : null}
                          {renderMetadata(item)}
                          {item.manualMonitorOwned ? (
                            <Typography.Text type="secondary">
                              {t("subscriptions.content.monitorOwnedHint")}
                            </Typography.Text>
                          ) : null}
                        </Space>
                      </Space>
                    </List.Item>
                  )}
                />
              ),
            }))}
          />
        )}
      </Card>

      <Card
        className="content-card"
        title={t("subscriptions.content.keywordComposerTitle")}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("subscriptions.content.keywordComposerDescription")}
          </Typography.Text>
          <Input.Search
            allowClear
            enterButton={t("subscriptions.content.keywordComposerAction")}
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onSearch={(value) => void handleAddKeywords(value)}
            loading={addingKeywords}
            placeholder={t("subscriptions.content.keywordComposerPlaceholder")}
          />
        </Space>
      </Card>

      <Card
        className="content-card"
        title={t("subscriptions.content.catalogTitle")}
        extra={
          <Space size="small">
            <Select
              value={catalogKind}
              style={{ width: 140 }}
              options={[
                {
                  value: "all",
                  label: t("subscriptions.content.kindAll"),
                },
                {
                  value: "topic",
                  label: t("subscriptions.content.kindTopics"),
                },
                {
                  value: "entity",
                  label: t("subscriptions.content.kindEntities"),
                },
                {
                  value: "source",
                  label: t("subscriptions.content.kindSources"),
                },
                {
                  value: "keyword",
                  label: t("subscriptions.content.kindKeywords"),
                },
                {
                  value: "geo",
                  label: t("subscriptions.content.kindGeos"),
                },
              ]}
              onChange={(value) => setCatalogKind(value)}
            />
            <Input.Search
              allowClear
              value={catalogInput}
              onChange={(event) => setCatalogInput(event.target.value)}
              onSearch={(value) => setCatalogQuery(value)}
              placeholder={t("subscriptions.content.catalogSearch")}
              style={{ width: 260 }}
            />
            <Button onClick={() => setCatalogQuery(catalogInput)}>
              {t("common.search")}
            </Button>
            <Button
              disabled={selectedCatalogItems.length === 0}
              onClick={() => void handleBatchSubscribe(selectedCatalogItems)}
            >
              {t("subscriptions.content.batchSubscribe")}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Space wrap size={[8, 8]}>
            <Button
              size="small"
              type={taxonomyFilter === null ? "primary" : "default"}
              onClick={() => setTaxonomyFilter(null)}
            >
              {t("subscriptions.content.allCategories")}
            </Button>
            {taxonomyOptions.map((option) => (
              <Button
                key={option.value}
                size="small"
                type={taxonomyFilter === option.value ? "primary" : "default"}
                onClick={() => setTaxonomyFilter(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </Space>
          {loadingCatalog && !catalog ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : catalogGroups.length === 0 ? (
            <Empty
              description={t("subscriptions.content.catalogEmpty")}
            />
          ) : (
            <Collapse
              items={catalogGroups.map((group) => ({
                key: group.groupKey,
                label: `${group.title} (${group.items.length})`,
                children: (
                  <List
                    dataSource={group.items}
                    renderItem={(item) => {
                      const subscriptionKey = buildContentSubscriptionKey(
                        item.kind,
                        item.normalizedValue,
                      );
                      const isSubscribed = subscribedKeys.has(subscriptionKey);
                      return (
                        <List.Item
                          actions={[
                            <Button
                              key="subscribe"
                              type="link"
                              disabled={isSubscribed}
                              onClick={() => void handleBatchSubscribe([item])}
                            >
                              {isSubscribed
                                ? t("subscriptions.content.subscribed")
                                : t("subscriptions.content.subscribe")}
                            </Button>,
                          ]}
                        >
                          <Space
                            align="start"
                            size="middle"
                            style={{
                              width: "100%",
                              justifyContent: "space-between",
                            }}
                          >
                            <Checkbox
                              disabled={isSubscribed}
                              checked={selectedCatalogKeys.includes(
                                subscriptionKey,
                              )}
                              onChange={(event) => {
                                setSelectedCatalogKeys((current) =>
                                  event.target.checked
                                    ? Array.from(
                                        new Set([...current, subscriptionKey]),
                                      )
                                    : current.filter(
                                        (entry) => entry !== subscriptionKey,
                                      ),
                                );
                              }}
                            />
                            <Space
                              direction="vertical"
                              size={4}
                              style={{ flex: 1 }}
                            >
                              <Space wrap size={[6, 6]}>
                                <Typography.Text strong>
                                  {item.displayValue}
                                </Typography.Text>
                                <Tag
                                  color={getContentSubscriptionKindColor(
                                    item.kind,
                                  )}
                                >
                                  {getContentSubscriptionKindLabel(
                                    item.kind,
                                    t,
                                  )}
                                </Tag>
                                {item.taxonomyDisplayName ? (
                                  <Tag>{item.taxonomyDisplayName}</Tag>
                                ) : null}
                                <Tag>
                                  {t("subscriptions.content.itemCount", {
                                    count: item.count,
                                  })}
                                </Tag>
                              </Space>
                              <Typography.Text type="secondary">
                                {t("subscriptions.content.lastSeenAt", {
                                  time: formatDateTime(
                                    item.lastSeenAt,
                                    locale,
                                    DATE_TIME_FORMAT,
                                  ),
                                })}
                              </Typography.Text>
                              {renderMetadata(item)}
                            </Space>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                ),
              }))}
            />
          )}
        </Space>
      </Card>

      <Card
        className="content-card"
        title={
          <Space wrap size={[8, 8]}>
            <span>
              {t("subscriptions.content.recommendationsTitle")}
            </span>
            {recommendationsWarning ? (
              <Tag color="warning">
                {t("subscriptions.content.degradedBadge")}
              </Tag>
            ) : null}
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {recommendationsWarning ? (
            <Alert
              showIcon
              closable
              type="warning"
              message={recommendationsWarning.message}
              description={recommendationsWarning.description}
              onClose={() => setRecommendationsWarning(null)}
              action={
                <Button size="small" onClick={() => void loadRecommendations()}>
                  {t("common.retry")}
                </Button>
              }
            />
          ) : null}
          {loading && !recommendations ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : (recommendations?.items?.length ?? 0) === 0 ? (
            <Empty
              description={t(
                recommendationsWarning
                  ? "subscriptions.content.recommendationsUnavailable"
                  : "subscriptions.content.recommendationsEmpty",
                {
                  defaultValue: recommendationsWarning
                    ? "Recommendations are temporarily unavailable."
                    : "Read more articles to unlock personalized recommendations.",
                },
              )}
            />
          ) : (
            <List
              dataSource={recommendations?.items ?? []}
              renderItem={(item) => {
                const isSubscribed = subscribedKeys.has(
                  buildContentSubscriptionKey(item.kind, item.normalizedValue),
                );
                return (
                  <List.Item
                    actions={[
                      <Button
                        key="add"
                        type="link"
                        disabled={isSubscribed}
                        onClick={() =>
                          void handleBatchSubscribe([item], "recommendation")
                        }
                      >
                        {isSubscribed
                          ? t("subscriptions.content.subscribed")
                          : t("subscriptions.content.addOne")}
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space wrap size={[6, 6]}>
                          <Typography.Text strong>
                            {item.displayValue}
                          </Typography.Text>
                          <Tag
                            color={getContentSubscriptionKindColor(item.kind)}
                          >
                            {getContentSubscriptionKindLabel(item.kind, t)}
                          </Tag>
                          {item.taxonomyDisplayName ? (
                            <Tag>{item.taxonomyDisplayName}</Tag>
                          ) : null}
                        </Space>
                      }
                      description={
                        <Space wrap size={[6, 6]}>
                          <Typography.Text type="secondary">
                            {t("subscriptions.content.itemCount", {
                              count: item.count,
                            })}
                          </Typography.Text>
                          {typeof item.score === "number" ? (
                            <Typography.Text type="secondary">
                              {t("subscriptions.content.relevanceScore", {
                                score: item.score.toFixed(2),
                              })}
                            </Typography.Text>
                          ) : null}
                          {renderMetadata(item)}
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          )}
        </Space>
      </Card>
    </div>
  );

  async function handleBatchRemoveSingle(item: ContentSubscriptionItem) {
    if (item.manualMonitorOwned) {
      openOwnerMonitor(item);
      return;
    }
    try {
      await apiClient.post<ContentSubscriptionBatchResponse>(
        "user-content-subscriptions/batch-delete",
        {
          subscriptions: [{ kind: item.kind, value: item.normalizedValue }],
        },
      );
      trackSubscriptionRemoval(item);
      setSelectedSubscriptionKeys((current) =>
        current.filter(
          (entry) =>
            entry !==
            buildContentSubscriptionKey(item.kind, item.normalizedValue),
        ),
      );
      message.success(
        t("subscriptions.content.removedSingle"),
      );
      await refreshSubscriptionViews();
      emitSituationMonitorMonitorsUpdated("subscriptions");
    } catch (error) {
      captureClientError("Failed to remove single content subscription", error);
      message.error(
        t("subscriptions.content.removeSingleFailed"),
      );
    }
  }
}

function groupByTaxonomy<
  T extends {
    kind: ContentSubscriptionKind;
    taxonomyPath: string | null;
    taxonomyDisplayName: string | null;
    taxonomyLabels: string[];
  },
>(items: T[]): GroupedItems<T>[] {
  const groups = new Map<string, GroupedItems<T>>();
  for (const item of items) {
    const groupKey = item.taxonomyPath ?? UNCATEGORIZED_TAXONOMY_FILTER;
    const current = groups.get(groupKey);
    if (current) {
      current.items.push(item);
      continue;
    }
    groups.set(groupKey, {
      groupKey,
      title: item.taxonomyDisplayName ?? "Uncategorized",
      labels: item.taxonomyLabels ?? [],
      items: [item],
    });
  }

  return Array.from(groups.values()).sort(
    (a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title),
  );
}
