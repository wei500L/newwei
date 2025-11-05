"use client";

import { Button, Input, Space, Table, Tag } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createApiClient } from "@/lib/api-client";

interface ItemsTableProps {
  accessToken: string;
}

interface ItemMeta {
  id: string;
  externalId: string;
  name: string;
  status: string;
  createdAt: string;
}

interface ItemsResponse {
  items: ItemMeta[];
  total: number;
  page: number;
  pageSize: number;
}

export function ItemsTable({ accessToken }: ItemsTableProps) {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 10
  });

  const { data, isFetching, refetch } = useQuery<ItemsResponse>({
    queryKey: ["items", pagination.current, pagination.pageSize, search],
    queryFn: async () => {
      const client = createApiClient({ accessToken });
      const response = await client.get<ItemsResponse>("/items", {
        params: {
          page: pagination.current,
          pageSize: pagination.pageSize,
          search: search || undefined
        }
      });
      return response.data;
    }
  });

  const handleTableChange = (pager: TablePaginationConfig) => {
    setPagination(pager);
  };

  const columns: ColumnsType<ItemMeta> = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name"
    },
    {
      title: "External ID",
      dataIndex: "externalId",
      key: "externalId"
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
        <Button type="primary" onClick={() => refetch()} loading={isFetching}>
          Refresh
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data?.items ?? []}
        loading={isFetching}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: data?.total,
          showSizeChanger: true
        }}
        onChange={handleTableChange}
      />
    </div>
  );
}
