"use client";

import { Button, Input, Space, Table, Tag } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useCallback, useMemo, useState } from "react";
import { useItemsQuery } from "@/graphql/generated";

export function ItemsTable() {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 10
  });

  const pageSize = pagination.pageSize ?? 10;

  const { data, loading, refetch, fetchMore } = useItemsQuery({
    variables: {
      first: pageSize,
      after: null,
      search: search || null
    },
    notifyOnNetworkStatusChange: true
  });

  const edges = data?.items.edges ?? [];
  const totalCount = data?.items.totalCount ?? 0;

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
            search: search || null
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
    [data?.items, fetchMore, search]
  );

  const pageData = useMemo(() => {
    const startIndex = ((pagination.current ?? 1) - 1) * (pagination.pageSize ?? 10);
    const endIndex = startIndex + (pagination.pageSize ?? 10);
    return edges.slice(startIndex, endIndex).map((edge) => ({
      ...edge.node,
      name: edge.node.title,
      createdAt: new Date(edge.node.createdAt).toISOString()
    }));
  }, [edges, pagination.current, pagination.pageSize]);

  const handleTableChange = (pager: TablePaginationConfig) => {
    void (async () => {
      const nextPage = pager.current ?? 1;
      const nextPageSize = pager.pageSize ?? pageSize;
      const pageSizeChanged = nextPageSize !== pageSize;
      setPagination({
        current: nextPage,
        pageSize: nextPageSize
      });
      if (pageSizeChanged) {
        await refetch({
          first: nextPageSize,
          after: null,
          search: search || null
        });
        return;
      }
      if (edges.length < nextPage * nextPageSize && data?.items?.pageInfo?.hasNextPage) {
        await ensurePageData(nextPage, nextPageSize);
      }
    })();
  };

  const handleSearch = (value: string) => {
    const nextValue = value.trim();
    setPagination((prev) => ({ ...prev, current: 1 }));
    setSearch(nextValue);
    void refetch({
      first: pageSize,
      after: null,
      search: nextValue || null
    });
  };

  const columns: ColumnsType<{ id: string; title: string; status: string; createdAt: string; name: string }> = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name"
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => <Tag color={status === "active" ? "green" : "blue"}>{status}</Tag>
    },
    {
      title: "Created",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (value: string) => new Date(value).toLocaleString()
    }
  ];

  return (
    <div className="content-card">
      <Space style={{ marginBottom: "1rem" }}>
        <Input.Search
          placeholder="Search items"
          allowClear
          onSearch={handleSearch}
          enterButton
        />
        <Button type="primary" onClick={() => refetch()} loading={loading}>
          Refresh
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={pageData}
        loading={loading}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: totalCount,
          showSizeChanger: true
        }}
        onChange={handleTableChange}
      />
    </div>
  );
}
