"use client";

import { Button, Input, Space, Table, Tag } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useMemo, useState } from "react";
import { useItemsQuery } from "@/graphql/generated";

export function ItemsTable() {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 10
  });

  const first = (pagination.pageSize ?? 10) * (pagination.current ?? 1);

  const { data, loading, refetch } = useItemsQuery({
    variables: {
      first,
      after: null,
      search: search || null
    }
  });

  const nodes = data?.items.edges ?? [];
  const totalCount = data?.items.totalCount ?? 0;

  const pageData = useMemo(() => {
    const startIndex = ((pagination.current ?? 1) - 1) * (pagination.pageSize ?? 10);
    const endIndex = startIndex + (pagination.pageSize ?? 10);
    return nodes.slice(startIndex, endIndex).map((edge) => ({
      ...edge.node,
      name: edge.node.title,
      createdAt: new Date(edge.node.createdAt).toISOString()
    }));
  }, [nodes, pagination.current, pagination.pageSize]);

  const handleTableChange = (pager: TablePaginationConfig) => {
    setPagination(pager);
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
          onSearch={(value) => {
            setPagination((prev) => ({ ...prev, current: 1 }));
            setSearch(value);
          }}
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
