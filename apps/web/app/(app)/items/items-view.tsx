"use client";

import { SearchOutlined } from "@ant-design/icons";
import { Button, Col, Drawer, Grid, Input, List, Row, Skeleton, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dayjs from "@/lib/dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ItemsQuery } from "@/graphql/generated";
import { useItemsQuery } from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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

type ItemEdge = ItemsQuery["items"]["edges"][number];

const EMPTY_EDGES: ItemEdge[] = [];

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
  qualityScore?: number;
  url?: string;
  history?: { timestamp: string; value: number }[];
}

export function ItemsView({ initialView = "list" }: { initialView?: ItemViewType }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const screens = Grid.useBreakpoint();

  // URL State
  const urlSearch = (searchParams.get("q") ?? "").trim();
  const current = parsePositiveInt(searchParams.get("page"), 1);
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 10);
  
  // Local State
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [view, setView] = useState<ItemViewType>(initialView);
  const [filters, setFilters] = useState<FilterState>({});
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    setSearchInput(urlSearch);
  }, [urlSearch]);

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

  const { data, loading, refetch, fetchMore } = useItemsQuery({
    variables: {
      first: pageSize,
      after: null,
      search: urlSearch || null
    },
    notifyOnNetworkStatusChange: true
  });

  const edges = data?.items.edges ?? EMPTY_EDGES;
  const totalCount = data?.items.totalCount ?? 0;
  const needsMoreForPage = Boolean(data?.items.pageInfo.hasNextPage) && edges.length < current * pageSize;

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
            search: urlSearch || null
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
    [data?.items, fetchMore, urlSearch]
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
        qualityScore:
          typeof processed.quality_score === "number" ? processed.quality_score : undefined,
        url: raw.url ?? undefined,
        location: processed.location ?? undefined
      } as ParsedItem;
    });
  }, [current, edges, pageSize]);

  // Note: Filtering is currently performed client-side on the fetched page of data.
  // The backend GraphQL API currently only supports a simple 'search' string.
  // For production with large datasets, these filters should be implemented on the server.
  const filteredData = useMemo(() => {
    return pageData.filter(item => {
      if (filters.regions?.length) {
         const regionValue = item.region ?? item.location;
         if (regionValue && !filters.regions.includes(regionValue)) return false;
      }
      if (filters.sentiments?.length) {
         if (item.sentiment && !filters.sentiments.includes(item.sentiment.toLowerCase())) return false;
      }
      if (filters.topics?.length) {
        const itemTopics = [
          ...(item.topics ?? []),
          ...(item.tags ?? [])
        ];
        const matches = itemTopics.some(tag => filters.topics?.includes(tag));
        if (!matches) return false;
      }
      if (filters.dateRange) {
        const [start, end] = filters.dateRange;
        const itemDate = dayjs(item.publishedAt ?? item.ingestedAt ?? item.createdAt);
        if (start && itemDate.isBefore(start, 'day')) return false;
        if (end && itemDate.isAfter(end, 'day')) return false;
      }
      return true;
    });
  }, [pageData, filters]);

  const availableRegions = useMemo(() => {
    const regions = pageData
      .map((item) => item.region ?? item.location)
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(regions));
  }, [pageData]);

  const availableTopics = useMemo(() => {
    const topics = pageData
      .flatMap((item) => [...(item.topics ?? []), ...(item.tags ?? [])])
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(topics));
  }, [pageData]);


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
                minute: "2-digit"
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
    }
  ];

  const renderContent = () => {
    if (loading && !pageData.length) {
      return <Skeleton active paragraph={{ rows: 6 }} />;
    }

    if (view === "list") {
      return (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filteredData}
          loading={loading || needsMoreForPage}
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
          dataSource={filteredData}
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
                     qualityScore: item.qualityScore,
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
              dataSource={filteredData}
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
                       qualityScore: item.qualityScore,
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
                  onFilterChange={setFilters}
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
           onFilterChange={setFilters}
           regions={availableRegions}
           topics={availableTopics}
         />
      </Drawer>
    </div>
  );
}
