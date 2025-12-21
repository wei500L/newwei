"use client";

import { Button, Input, Space, Table, Tag } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { useItemsQuery } from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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

export function ItemsTable() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlSearch = (searchParams.get("q") ?? "").trim();
  const current = parsePositiveInt(searchParams.get("page"), 1);
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 10);

  const [searchInput, setSearchInput] = useState(urlSearch);
  useEffect(() => {
    setSearchInput(urlSearch);
  }, [urlSearch]);

  const setQueryParams = useCallback(
    (updates: { q?: string | null; page?: number | null; pageSize?: number | null }) => {
      const currentQuery = searchParams.toString();
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
      if (nextQuery === currentQuery) {
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

  const edges = data?.items.edges ?? [];
  const totalCount = data?.items.totalCount ?? 0;
  const needsMoreForPage = Boolean(data?.items.pageInfo.hasNextPage) && edges.length < current * pageSize;

  const ensurePageData = useCallback(
    async (targetPage: number, size: number) => {
      if (!data?.items) {
        return;
      }
      let current = data.items;
      while (
        current.edges.length < targetPage * size &&
        current.pageInfo.hasNextPage &&
        current.pageInfo.endCursor
      ) {
        const result = await fetchMore({
          variables: {
            first: size,
            after: current.pageInfo.endCursor,
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
        current = result.data.items;
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

  const pageData = useMemo(() => {
    const startIndex = (current - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return edges.slice(startIndex, endIndex).map((edge) => ({
      ...edge.node,
      name: edge.node.title,
      createdAt: new Date(edge.node.createdAt).toISOString()
    }));
  }, [current, edges, pageSize]);

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

  const columns: ColumnsType<{ id: string; title: string; status: string; createdAt: string; name: string }> = [
    {
      title: t("items.columns.name"),
      dataIndex: "name",
      key: "name"
    },
    {
      title: t("items.columns.status"),
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={status === "active" ? "green" : "blue"}>
          {t(`items.status.${status}`, { defaultValue: status })}
        </Tag>
      )
    },
    {
      title: t("items.columns.created"),
      dataIndex: "createdAt",
      key: "createdAt",
      render: (value: string) =>
        formatDateTime(value, locale, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        })
    }
  ];

  return (
    <div className="content-card">
      <Space style={{ marginBottom: "1rem" }}>
        <Input.Search
          placeholder={t("items.search.placeholder")}
          allowClear
          value={searchInput}
          onSearch={handleSearch}
          onChange={(event) => {
            const value = event.target.value;
            setSearchInput(value);
            if (!value) {
              setQueryParams({ q: null, page: 1 });
            }
          }}
          enterButton
        />
        <Button type="primary" onClick={() => refetch()} loading={loading}>
          {t("common.refresh")}
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={pageData}
        loading={loading || needsMoreForPage}
        pagination={{
          current,
          pageSize,
          total: totalCount,
          showSizeChanger: true
        }}
        onChange={handleTableChange}
      />
    </div>
  );
}
