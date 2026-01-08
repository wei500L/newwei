"use client";

import { SearchOutlined } from "@ant-design/icons";
import { Button, Col, Drawer, Grid, Input, List, Row, Skeleton, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { gql, useQuery } from "@apollo/client";
import dayjs from "@/lib/dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "next-auth/react";

import type { ItemsQuery } from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { ChartEmptyState } from "@/components/chart-empty-state";

import { FacetedSearch, FilterState } from "./components/faceted-search";
import { FinancialCard } from "./components/financial-card";
import { NewsCard } from "./components/news-card";
import { ItemViewType, ViewSwitcher } from "./components/view-switcher";

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

interface ItemsQueryVariables {
  first: number;
  after?: string | null;
  search?: string | null;
  filters?: ItemsFiltersInput | null;
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
  query Items($first: Int!, $after: String, $search: String, $filters: ItemsFiltersInput) {
    items(first: $first, after: $after, search: $search, filters: $filters) {
      edges {
        node {
          id
          title
          status
          createdAt
          processed {
            result
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
  tags?: string[];
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
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 10);
  
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
    refetch,
    fetchMore
  } = useQuery<ItemsQuery, ItemsQueryVariables>(ITEMS_QUERY, {
    variables: {
      first: pageSize,
      after: null,
      search: urlSearch || null,
      filters: filtersInput
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
  const needsMoreForPage =
    Boolean(resolvedData?.items.pageInfo.hasNextPage) && edges.length < current * pageSize;

  const ensurePageData = useCallback(
    async (targetPage: number, size: number) => {
      if (!data?.items) {
        return;
      }
      let currentItems = data.items;
      while (
        currentItems.edges.length < targetPage * size &&
        currentItems.pageInfo.hasNextPage &&
        currentItems.pageInfo.endCursor
      ) {
        const result = await fetchMore({
          variables: {
            first: size,
            after: currentItems.pageInfo.endCursor,
            search: urlSearch || null,
            filters: filtersInput
          },
          updateQuery: (prev, { fetchMoreResult }) => {
            if (!fetchMoreResult) {
              return prev;
            }
            return {
              ...fetchMoreResult,
              items: {
                ...fetchMoreResult.items,
                edges: [...prev.items.edges, ...fetchMoreResult.items.edges],
                totalCount: fetchMoreResult.items.totalCount,
                pageInfo: fetchMoreResult.items.pageInfo
              }
            };
          }
        });
        currentItems = result.data.items;
      }
    },
    [data?.items, fetchMore, filtersInput, urlSearch]
  );

  useEffect(() => {
    if (!data?.items) {
      return;
    }
    if (needsMoreForPage) {
      void ensurePageData(current, pageSize);
    }
  }, [current, data?.items, ensurePageData, needsMoreForPage, pageSize]);

  const pageData = useMemo<ParsedItem[]>(() => {
    const startIndex = (current - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return edges.slice(startIndex, endIndex).map((edge) => {
      let parsedRaw = {};
      let parsedProcessed = {};
      try {
        parsedRaw = JSON.parse(edge.node.raw?.payload || '{}');
      } catch (e) {
        // console.warn("Failed to parse raw payload", e);
      }
      try {
        parsedProcessed = JSON.parse(edge.node.processed?.result || '{}');
      } catch (e) {
        // console.warn("Failed to parse processed result", e);
      }

      const processed = parsedProcessed as {
        published_at?: string | null;
        source?: string | null;
        topics?: string[] | null;
        entities?: Array<{ name?: string | null } | string> | null;
        quality_score?: number | null;
        location?: string | null;
      };
      const raw = parsedRaw as {
        publishedAt?: string | null;
        published_at?: string | null;
        url?: string | null;
        sourceName?: string | null;
      };
      const publishedAt =
        processed.published_at ??
        raw.publishedAt ??
        raw.published_at ??
        undefined;
      const ingestedAt = dayjs(edge.node.createdAt).toISOString();
      const entities = Array.isArray(processed.entities)
        ? Array.from(
            new Set(
              processed.entities
                .map((entity) => {
                  if (typeof entity === "string") {
                    return entity;
                  }
                  if (entity && typeof entity.name === "string") {
                    return entity.name;
                  }
                  return null;
                })
                .filter((name): name is string => Boolean(name))
            )
          )
        : [];

      return {
        ...edge.node,
        ...parsedRaw,
        ...parsedProcessed,
        name: edge.node.title,
        tags: edge.node.processed?.tags || [],
        publishedAt,
        ingestedAt,
        createdAt: ingestedAt,
        source: processed.source ?? raw.sourceName ?? undefined,
        topics: Array.isArray(processed.topics) ? processed.topics : [],
        entities,
        qualityScore:
          typeof processed.quality_score === "number" ? processed.quality_score : undefined,
        duplicateSimilarity:
          typeof edge.node.processed?.duplicateSimilarity === "number"
            ? edge.node.processed.duplicateSimilarity
            : undefined,
        duplicateOf: edge.node.processed?.duplicateOf ?? null,
        llm: edge.node.processed?.llm ?? undefined,
        url: raw.url ?? undefined,
        location: processed.location ?? undefined
      } as ParsedItem;
    });
  }, [current, edges, pageSize]);

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
        ...(item.tags ?? []),
        ...(item.entities ?? [])
      ])
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(fallback));
  }, [facetsData, pageData]);

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

  const sortedData = useMemo(() => {
    if (sortMode !== "publishedDesc") {
      return pageData;
    }
    return [...pageData].sort((a, b) => {
      const aTime = dayjs(a.publishedAt ?? a.ingestedAt ?? a.createdAt).valueOf();
      const bTime = dayjs(b.publishedAt ?? b.ingestedAt ?? b.createdAt).valueOf();
      return bTime - aTime;
    });
  }, [pageData, sortMode]);


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
      title: t("items.columns.published", { defaultValue: "Published" }),
      dataIndex: "publishedAt",
      key: "publishedAt",
      render: (_: string | undefined, record) => {
        const value = record.publishedAt ?? record.ingestedAt ?? record.createdAt;
        const label = record.publishedAt
          ? t("items.time.published", { defaultValue: "Published" })
          : t("items.time.ingested", { defaultValue: "Ingested" });
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text>
              {formatDateTime(value, locale, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              })}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {label}
            </Typography.Text>
          </Space>
        );
      }
    },
    {
      title: t("items.columns.quality", { defaultValue: "Quality" }),
      dataIndex: "qualityScore",
      key: "qualityScore",
      render: (value: number | undefined) =>
        typeof value === "number" ? (
          <Tag color="blue">{Math.round(value * 100)}%</Tag>
        ) : (
          <Tag>{t("common.notAvailable")}</Tag>
        )
    },
    {
      title: t("items.columns.duplicate", { defaultValue: "Duplicate" }),
      dataIndex: "duplicateSimilarity",
      key: "duplicateSimilarity",
      render: (value: number | undefined, record) => {
        if (typeof value !== "number") {
          return <Tag>{t("common.notAvailable")}</Tag>;
        }
        const label = record.duplicateOf
          ? t("items.duplicate.duplicate", { defaultValue: "Duplicate" })
          : t("items.duplicate.similarity", { defaultValue: "Similarity" });
        return <Tag color="gold">{label} {Math.round(value * 100)}%</Tag>;
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

    if (error && sortedData.length === 0) {
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

    if (!loading && sortedData.length === 0) {
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
          dataSource={sortedData}
          loading={loading || needsMoreForPage}
          size="large"
          pagination={{
            current,
            pageSize,
            total: totalCount,
            showSizeChanger: true,
          }}
          onChange={handleTableChange}
        />
      );
    }

    if (view === "grid") {
      return (
        <List
          grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4, xxl: 4 }}
          dataSource={sortedData}
          pagination={{
             current,
             pageSize,
             total: totalCount,
             onChange: (page, size) => setQueryParams({ page, pageSize: size }),
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
              dataSource={sortedData}
              pagination={{
                 current,
                 pageSize,
                 total: totalCount,
                 onChange: (page, size) => setQueryParams({ page, pageSize: size }),
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
         />
      </Drawer>
    </div>
  );
}
