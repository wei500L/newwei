"use client";

import { InfoCircleOutlined, SearchOutlined } from "@ant-design/icons";
import { gql, useQuery } from "@apollo/client";
import { Button, Col, Drawer, Grid, Input, List, Row, Skeleton, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import type { ItemsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { formatRatioAsPercent } from "@/lib/metrics-format";

import { FacetedSearch, type FilterState } from "./components/faceted-search";
import { NewsCard } from "./components/news-card";
import { type ItemViewType, ViewSwitcher } from "./components/view-switcher";

const FinancialCard = dynamic(
  () => import("./components/financial-card").then((mod) => mod.FinancialCard),
  { loading: () => <Skeleton active paragraph={{ rows: 3 }} /> }
);

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function normalizeFilterList(
  values?: string[],
  options?: { lowerCase?: boolean }
): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => (options?.lowerCase ? value.toLowerCase() : value));
  if (normalized.length === 0) {
    return undefined;
  }
  return Array.from(new Set(normalized));
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function withMetricTooltip(label: string, tooltip: string) {
  return (
    <Space size={6}>
      <span>{label}</span>
      <Tooltip title={tooltip}>
        <InfoCircleOutlined className="text-slate-400" />
      </Tooltip>
    </Space>
  );
}

const MAX_ITEMS_PAGE_SIZE = 50;

const loggedProcessedResultParseErrors = new Set<string>();

function parseProcessedResult(value: unknown, itemId: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value === "object") {
    return !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  if (typeof value !== "string") {
    return {};
  }

  const resultString = value;
  if (!resultString.trim()) {
    return {};
  }

  const reportOnce = (error: unknown) => {
    if (loggedProcessedResultParseErrors.has(itemId)) {
      return;
    }
    loggedProcessedResultParseErrors.add(itemId);
    captureClientError("Failed to parse processed.result", error, {
      tags: { area: "items", field: "processed.result" },
      extras: { itemId, resultLength: resultString.length }
    });
  };

  try {
    let parsed: unknown = resultString;
    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof parsed !== "string") {
        break;
      }
      parsed = JSON.parse(parsed) as unknown;
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    reportOnce(error);
    return {};
  }
}

interface ItemsDateRangeInput {
  start?: string;
  end?: string;
}

interface ItemsFiltersInput {
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
  dateRange?: ItemsDateRangeInput;
}

type ItemsOrderBy = "CREATED_DESC" | "PUBLISHED_DESC";

interface ItemsQueryVariables {
  first: number;
  after?: string | null;
  page?: number | null;
  search?: string | null;
  filters?: ItemsFiltersInput | null;
  orderBy?: ItemsOrderBy | null;
}

interface ItemFacetOption {
  value: string;
  count: number;
}

interface ItemFacetsQuery {
  itemFacets: {
    regions: ItemFacetOption[];
    topics: ItemFacetOption[];
    sentiments: ItemFacetOption[];
  };
}

interface ItemFacetsQueryVariables {
  search?: string | null;
  filters?: ItemsFiltersInput | null;
}

const ITEMS_QUERY = gql`
  query Items($first: Int!, $after: String, $page: Int, $search: String, $filters: ItemsFiltersInput, $orderBy: ItemsOrderBy) {
    items(first: $first, after: $after, page: $page, search: $search, filters: $filters, orderBy: $orderBy) {
      edges {
        node {
          id
          title
          status
          createdAt
          ingestedAt
          publishedAt
          processed {
            result
            resultJson
            tags
            duplicateOf
            duplicateSimilarity
            llm {
              model
              promptVersion
              promptTokens
              completionTokens
              totalTokens
              costUsd
              latencyMs
            }
          }
          raw {
            payload
            source
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      totalCount
    }
  }
`;

const ITEM_FACETS_QUERY = gql`
  query ItemFacets($search: String, $filters: ItemsFiltersInput) {
    itemFacets(search: $search, filters: $filters) {
      regions {
        value
        count
      }
      topics {
        value
        count
      }
      sentiments {
        value
        count
      }
    }
  }
`;

function buildFiltersInput(filters: FilterState): ItemsFiltersInput | null {
  const regions = normalizeFilterList(filters.regions);
  const topics = normalizeFilterList(filters.topics);
  const sentiments = normalizeFilterList(filters.sentiments, { lowerCase: true });
  const rangeStart = filters.dateRange?.[0]?.startOf("day");
  const rangeEnd = filters.dateRange?.[1]?.endOf("day");
  const dateRange =
    rangeStart || rangeEnd
      ? {
          ...(rangeStart ? { start: rangeStart.toISOString() } : {}),
          ...(rangeEnd ? { end: rangeEnd.toISOString() } : {})
        }
      : undefined;

  if (!regions && !topics && !sentiments && !dateRange) {
    return null;
  }

  return {
    ...(regions ? { regions } : {}),
    ...(topics ? { topics } : {}),
    ...(sentiments ? { sentiments } : {}),
    ...(dateRange ? { dateRange } : {})
  };
}

type ItemEdge = ItemsQuery["items"]["edges"][number];

const EMPTY_EDGES: ItemEdge[] = [];

type EmptyStateVariant = "default" | "today" | "search";
type ItemsSortMode = "default" | "publishedDesc";

interface ItemsViewProps {
  initialView?: ItemViewType;
  emptyStateVariant?: EmptyStateVariant;
  sortMode?: ItemsSortMode;
  initialData?: ItemsQuery | null;
}

interface ParsedItem {
  id: string;
  title: string;
  name: string;
  status: string;
  createdAt: string;
  publishedAt?: string;
  ingestedAt?: string;
  sentiment?: string;
  summary?: string;
  thumbnail?: string;
  source?: string;
  price?: number;
  change?: number;
  ticker?: string;
  region?: string;
  location?: string;
  topics?: string[];
  entities?: string[];
  qualityScore?: number;
  duplicateSimilarity?: number;
  duplicateOf?: string | null;
  llm?: {
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  };
  url?: string;
  history?: { timestamp: string; value: number }[];
}

export function ItemsView({
  initialView = "feed",
  emptyStateVariant = "default",
  sortMode = "default",
  initialData = null
}: ItemsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const screens = Grid.useBreakpoint();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageCrawl = permissions.includes("crawl.read") || permissions.includes("crawl.write");

  // URL State
  const urlSearch = (searchParams.get("q") ?? "").trim();
  const current = parsePositiveInt(searchParams.get("page"), 1);
  const rawPageSize = parsePositiveInt(searchParams.get("pageSize"), 10);
  const pageSize = Math.min(rawPageSize, MAX_ITEMS_PAGE_SIZE);
  
  // Local State
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [view, setView] = useState<ItemViewType>(initialView);
  const [filters, setFilters] = useState<FilterState>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showDelayHint, setShowDelayHint] = useState(false);

  useEffect(() => {
    setSearchInput(urlSearch);
  }, [urlSearch]);

  const filtersInput = useMemo(() => buildFiltersInput(filters), [filters]);
  const orderBy = useMemo<ItemsOrderBy>(
    () => (sortMode === "publishedDesc" ? "PUBLISHED_DESC" : "CREATED_DESC"),
    [sortMode]
  );

  const setQueryParams = useCallback(
    (updates: { q?: string | null; page?: number | null; pageSize?: number | null }) => {
      const next = new URLSearchParams(searchParams.toString());
      if (updates.q !== undefined) {
        const value = updates.q?.trim() ?? "";
        if (value) {
          next.set("q", value);
        } else {
          next.delete("q");
        }
      }
      if (updates.page !== undefined) {
        const value = updates.page ?? 1;
        if (value > 1) {
          next.set("page", String(value));
        } else {
          next.delete("page");
        }
      }
      if (updates.pageSize !== undefined) {
        const value = updates.pageSize ?? 10;
        if (value !== 10) {
          next.set("pageSize", String(value));
        } else {
          next.delete("pageSize");
        }
      }
      const nextQuery = next.toString();
      if (nextQuery === searchParams.toString()) {
        return;
      }
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    if (rawPageSize === pageSize) {
      return;
    }
    setQueryParams({ pageSize });
  }, [pageSize, rawPageSize, setQueryParams]);

  const handleFilterChange = useCallback(
    (nextFilters: FilterState) => {
      setFilters(nextFilters);
      setQueryParams({ page: 1 });
    },
    [setQueryParams]
  );

  const {
    data,
    loading,
    error,
    refetch
  } = useQuery<ItemsQuery, ItemsQueryVariables>(ITEMS_QUERY, {
    variables: {
      first: pageSize,
      after: null,
      page: current,
      search: urlSearch || null,
      filters: filtersInput,
      orderBy
    },
    notifyOnNetworkStatusChange: true
  });

  const { data: facetsData } = useQuery<ItemFacetsQuery, ItemFacetsQueryVariables>(ITEM_FACETS_QUERY, {
    variables: {
      search: urlSearch || null,
      filters: filtersInput
    },
    fetchPolicy: "cache-and-network"
  });

  useEffect(() => {
    if (!loading) {
      setShowDelayHint(false);
      return;
    }
    const timeout = setTimeout(() => setShowDelayHint(true), 1200);
    return () => clearTimeout(timeout);
  }, [loading]);

  const resolvedData = data ?? initialData ?? undefined;
  const edges = resolvedData?.items.edges ?? EMPTY_EDGES;
  const totalCount = resolvedData?.items.totalCount ?? 0;

  const pageData = useMemo<ParsedItem[]>(() => {
    return edges.map((edge) => {
      let parsedRaw = {};
      try {
        parsedRaw = JSON.parse(edge.node.raw?.payload || "{}");
      } catch {
        // console.warn("Failed to parse raw payload", e);
      }

      const processed = parseProcessedResult(
        edge.node.processed?.resultJson ?? edge.node.processed?.result,
        edge.node.id
      ) as {
        published_at?: string | null;
        source?: string | null;
        topics?: string[] | null;
        entities?: ({ name?: string | null } | string)[] | null;
        quality_score?: number | null;
        location?: string | null;
      };
      const raw = parsedRaw as {
        publishedAt?: string | null;
        published_at?: string | null;
        url?: string | null;
        sourceName?: string | null;
      };
      const publishedAt = toNonEmptyString(edge.node.publishedAt) ?? undefined;
      const ingestedAt = dayjs(edge.node.ingestedAt ?? edge.node.createdAt).toISOString();
      const topics = Array.isArray(processed.topics)
        ? Array.from(
            new Set(
              processed.topics
                .map((topic) => (typeof topic === "string" ? topic.trim() : ""))
                .filter((topic) => topic.length > 0)
            )
          )
        : [];
      const entities = Array.isArray(processed.entities)
        ? Array.from(
            new Set(
              processed.entities
                .map((entity) => {
                  if (typeof entity === "string") {
                    return entity.trim();
                  }
                  if (entity && typeof entity.name === "string") {
                    return entity.name.trim();
                  }
                  return "";
                })
                .filter((name) => name.length > 0)
            )
          )
        : [];

      return {
        ...edge.node,
        ...parsedRaw,
        ...processed,
        name: edge.node.title,
        publishedAt,
        ingestedAt,
        createdAt: ingestedAt,
        source: toNonEmptyString(processed.source) ?? toNonEmptyString(raw.sourceName) ?? undefined,
        topics,
        entities,
        qualityScore:
          typeof processed.quality_score === "number" ? processed.quality_score : undefined,
        duplicateSimilarity:
          typeof edge.node.processed?.duplicateSimilarity === "number"
            ? edge.node.processed.duplicateSimilarity
            : undefined,
        duplicateOf: edge.node.processed?.duplicateOf ?? null,
        llm: edge.node.processed?.llm ?? undefined,
        url: toNonEmptyString(raw.url) ?? undefined,
        location: processed.location ?? undefined
      } as ParsedItem;
    });
  }, [edges]);

  const availableRegions = useMemo(() => {
    const regions = facetsData?.itemFacets?.regions;
    if (regions && regions.length > 0) {
      return regions.map((region) => region.value);
    }
    const fallback = pageData
      .map((item) => item.region ?? item.location)
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(fallback));
  }, [facetsData, pageData]);

  const availableTopics = useMemo(() => {
    const topics = facetsData?.itemFacets?.topics;
    if (topics && topics.length > 0) {
      return topics.map((topic) => topic.value);
    }
    const fallback = pageData
      .flatMap((item) => [
        ...(item.topics ?? []),
      ])
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(fallback));
  }, [facetsData, pageData]);

  const availableSentiments = useMemo(() => {
    const sentiments = facetsData?.itemFacets?.sentiments;
    if (!sentiments || sentiments.length === 0) {
      return [];
    }
    const allowed = new Set(["positive", "neutral", "negative"]);
    const values = sentiments
      .map((sentiment) => sentiment.value.trim().toLowerCase())
      .filter((value) => value.length > 0 && allowed.has(value));
    return Array.from(new Set(values));
  }, [facetsData]);

  useEffect(() => {
    if (availableSentiments.length > 0) {
      return;
    }
    if (!filters.sentiments || filters.sentiments.length === 0) {
      return;
    }
    setFilters((current) => ({ ...current, sentiments: undefined }));
  }, [availableSentiments.length, filters.sentiments]);

  const emptyStateConfig = useMemo(() => {
    if (emptyStateVariant === "today") {
      const action = canManageCrawl
        ? {
            label: t("items.empty.todayActionAdmin", { defaultValue: "Manage crawl tasks" }),
            href: "/admin/ops/crawl-tasks"
          }
        : {
            label: t("items.empty.todayActionSubscriber", {
              defaultValue: "Manage subscriptions"
            }),
            href: "/subscriptions"
          };
      return {
        title: t("items.empty.todayTitle", { defaultValue: "No news in this window" }),
        description: t("items.empty.todayDescription", {
          defaultValue: "Try adjusting filters or check back later."
        }),
        actionLabel: action.label,
        actionHref: action.href
      };
    }

    if (emptyStateVariant === "search") {
      return {
        title: t("items.empty.searchTitle", { defaultValue: "No results" }),
        description: t("items.empty.searchDescription", {
          defaultValue: "Try adjusting your keywords or filters."
        })
      };
    }

    return {
      title: t("items.empty.defaultTitle", { defaultValue: "No items found" }),
      description: t("items.empty.defaultDescription", {
        defaultValue: "Try adjusting filters or refresh."
      })
    };
  }, [canManageCrawl, emptyStateVariant, t]);

  const handleTableChange = (pager: TablePaginationConfig) => {
    const nextPageSize = pager.pageSize ?? pageSize;
    const pageSizeChanged = nextPageSize !== pageSize;
    const nextPage = pageSizeChanged ? 1 : (pager.current ?? 1);

    setQueryParams({
      page: nextPage,
      pageSize: nextPageSize
    });
  };

  const handleSearch = (value: string) => {
    const nextValue = value.trim();
    setQueryParams({
      q: nextValue || null,
      page: 1
    });
  };

  const columns: ColumnsType<ParsedItem> = [
    {
      title: t("items.columns.name", { defaultValue: "Title" }),
      dataIndex: "name",
      key: "name"
    },
    {
      title: t("items.columns.source", { defaultValue: "Source" }),
      dataIndex: "source",
      key: "source",
      render: (value: string | undefined) => value ?? t("common.notAvailable")
    },
    {
      title: t("items.columns.time", { defaultValue: "Time" }),
      dataIndex: "publishedAt",
      key: "publishedAt",
      render: (_: string | undefined, record) => {
        const publishedLabel = t("items.time.published", { defaultValue: "Published" });
        const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
        const ingestedAt = record.ingestedAt ?? record.createdAt;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text>
              {publishedLabel}:{" "}
              {record.publishedAt
                ? formatDateTime(record.publishedAt, locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZoneName: "short"
                  })
                : t("common.notAvailable")}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {ingestedLabel}:{" "}
              {formatDateTime(ingestedAt, locale, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              })}
            </Typography.Text>
          </Space>
        );
      }
    },
    {
      title: withMetricTooltip(
        t("items.columns.quality", { defaultValue: "Quality" }),
        t("items.metrics.quality.tooltip", {
          defaultValue: "Quality score from LLM cleaning stage (0–1, shown as %)."
        })
      ),
      dataIndex: "qualityScore",
      key: "qualityScore",
      render: (value: number | undefined, record) => {
        const formatted = formatRatioAsPercent(value, locale);
        if (!formatted) {
          return <Tag>{t("common.notAvailable")}</Tag>;
        }

        const tooltip = (
          <div className="text-xs">
            <div>
              {t("items.metrics.quality.tooltip", {
                defaultValue: "Quality score from LLM cleaning stage (0–1, shown as %)."
              })}
            </div>
            {record.llm?.model ? <div>Model: {record.llm.model}</div> : null}
            {record.llm?.promptVersion ? <div>Prompt: {record.llm.promptVersion}</div> : null}
          </div>
        );

        return (
          <Tooltip title={tooltip}>
            <Tag color="blue">{formatted}</Tag>
          </Tooltip>
        );
      }
    },
    {
      title: withMetricTooltip(
        t("items.columns.duplicate", { defaultValue: "Duplicate" }),
        t("items.metrics.duplicate.tooltip", {
          defaultValue: "Duplicate similarity from dedup stage (0–1, shown as %)."
        })
      ),
      dataIndex: "duplicateSimilarity",
      key: "duplicateSimilarity",
      render: (value: number | undefined, record) => {
        const formatted = formatRatioAsPercent(value, locale);
        if (!formatted) {
          return <Tag>{t("common.notAvailable")}</Tag>;
        }
        const label = record.duplicateOf
          ? t("items.duplicate.duplicate", { defaultValue: "Duplicate" })
          : t("items.duplicate.similarity", { defaultValue: "Similarity" });

        const tooltip = (
          <div className="text-xs">
            <div>
              {t("items.metrics.duplicate.tooltip", {
                defaultValue: "Duplicate similarity from dedup stage (0–1, shown as %)."
              })}
            </div>
            {record.duplicateOf ? <div>Duplicate of: {record.duplicateOf}</div> : null}
          </div>
        );

        return (
          <Tooltip title={tooltip}>
            <Tag color="gold">
              {label} {formatted}
            </Tag>
          </Tooltip>
        );
      }
    },
    {
      title: t("items.columns.open", { defaultValue: "Open" }),
      key: "open",
      render: (_: unknown, record) => (
        <Button type="link" size="small" onClick={() => router.push(`/items/${record.id}`)} className="px-0">
          {t("items.detail.openItem", { defaultValue: "Open item" })}
        </Button>
      )
    }
  ];

  const renderContent = () => {
    if (loading && !pageData.length) {
      return (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Skeleton active paragraph={{ rows: 6 }} />
          {showDelayHint ? (
            <ChartEmptyState
              className="h-auto"
              description={t("common.loadingDelayed", {
                defaultValue: "Data is taking longer than usual. Please hold on or refresh."
              })}
            />
          ) : null}
        </Space>
      );
    }

    if (error && pageData.length === 0) {
      return (
        <Space direction="vertical" align="center" size="middle" style={{ width: "100%" }}>
          <ChartEmptyState
            className="h-auto"
            description={t("common.serviceUnavailable", {
              defaultValue: "Service is unavailable. Please try again."
            })}
          />
          <Button size="small" type="primary" onClick={() => refetch()}>
            {t("common.retry")}
          </Button>
        </Space>
      );
    }

    if (!loading && pageData.length === 0) {
      return (
        <Space direction="vertical" align="center" size="middle" style={{ width: "100%" }}>
          <ChartEmptyState
            className="h-auto"
            description={
              emptyStateConfig.description
                ? `${emptyStateConfig.title} · ${emptyStateConfig.description}`
                : emptyStateConfig.title
            }
          />
          {emptyStateConfig.actionLabel && emptyStateConfig.actionHref ? (
            <Button size="small" type="primary" onClick={() => router.push(emptyStateConfig.actionHref)}>
              {emptyStateConfig.actionLabel}
            </Button>
          ) : null}
        </Space>
      );
    }

    if (view === "list") {
      return (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={pageData}
          loading={loading}
          size="large"
          pagination={{
            current,
            pageSize,
            total: totalCount,
            showSizeChanger: true,
            pageSizeOptions: ["10", "20", "50"]
          }}
          onChange={handleTableChange}
        />
      );
    }

    if (view === "grid") {
      return (
        <List
          grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4, xxl: 4 }}
          dataSource={pageData}
          pagination={{
             current,
             pageSize,
             total: totalCount,
             onChange: (page, size) => setQueryParams({ page, pageSize: size }),
             showSizeChanger: true,
             pageSizeOptions: ["10", "20", "50"],
             align: 'center'
          }}
          renderItem={(item) => (
            <List.Item>
               {/* Naive heuristic to choose card type: if it has price/ticker, assume financial */}
               {(item.price !== undefined || item.ticker) ? (
                 <FinancialCard item={item} />
               ) : (
                 <NewsCard
                   item={{
                     ...item,
                     publishedAt: item.publishedAt,
                     ingestedAt: item.ingestedAt,
                     topics: item.topics,
                     entities: item.entities,
                     qualityScore: item.qualityScore,
                     duplicateSimilarity: item.duplicateSimilarity,
                     duplicateOf: item.duplicateOf,
                     llm: item.llm,
                     url: item.url
                   }}
                 />
               )}
            </List.Item>
          )}
        />
      );
    }

    if (view === "feed") {
        return (
            <List
              itemLayout="vertical"
              dataSource={pageData}
	              pagination={{
	                 current,
	                 pageSize,
	                 total: totalCount,
	                 onChange: (page, size) => setQueryParams({ page, pageSize: size }),
	                 showSizeChanger: true,
	                 pageSizeOptions: ["10", "20", "50"],
	                 align: 'center'
	              }}
              renderItem={(item) => (
                <List.Item>
                   <NewsCard
                     item={{
                       ...item,
                       publishedAt: item.publishedAt,
                       ingestedAt: item.ingestedAt,
                       topics: item.topics,
                       entities: item.entities,
                       qualityScore: item.qualityScore,
                       duplicateSimilarity: item.duplicateSimilarity,
                       duplicateOf: item.duplicateOf,
                       llm: item.llm,
                       url: item.url
                     }}
                   />
                </List.Item>
              )}
            />
        );
    }
    
    return null;
  };

  return (
    <div className="content-card" style={{ padding: "24px" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        
        {/* Header Controls */}
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
           <Col flex="auto">
             <Space>
                <Space.Compact>
                  <Input
                    placeholder={t("items.search.placeholder")}
                    allowClear
                    value={searchInput}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSearchInput(value);
                      if (!value) {
                        setQueryParams({ q: null, page: 1 });
                      }
                    }}
                    onPressEnter={() => handleSearch(searchInput)}
                  />
                  <Button
                    icon={<SearchOutlined />}
                    aria-label={t("items.search.placeholder")}
                    onClick={() => handleSearch(searchInput)}
                  />
                </Space.Compact>
                {!screens.lg && (
                    <Button onClick={() => setShowFilters(true)}>
                        {t("items.filters.button", { defaultValue: "Filters" })}
                    </Button>
                )}
             </Space>
           </Col>
           <Col>
              <Space>
                <ViewSwitcher view={view} onChange={setView} />
                <Button onClick={() => refetch()} loading={loading}>
                  {t("common.refresh")}
                </Button>
              </Space>
           </Col>
        </Row>

        {/* Main Layout */}
        <Row gutter={24}>
           {screens.lg && (
             <Col flex="280px">
                <FacetedSearch
                  filters={filters}
                  onFilterChange={handleFilterChange}
                  regions={availableRegions}
                  topics={availableTopics}
                  sentiments={availableSentiments}
                />
              </Col>
           )}
           <Col flex="auto">
              {renderContent()}
           </Col>
        </Row>

      </Space>

      <Drawer
        title={t("items.filters.title", { defaultValue: "Filters" })}
        placement="right"
        onClose={() => setShowFilters(false)}
        open={showFilters}
      >
         <FacetedSearch
           filters={filters}
           onFilterChange={handleFilterChange}
           regions={availableRegions}
           topics={availableTopics}
           sentiments={availableSentiments}
         />
      </Drawer>
    </div>
  );
}
