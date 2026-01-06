"use client";

import {
  Alert,
  Button,
  Card,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

interface AuditLogEntry {
  id: string;
  orgId: string;
  actorId?: string | null;
  resource: string;
  action: string;
  metadata?: unknown;
  ipAddress?: string | null;
  createdAt: string;
}

const LIMIT_OPTIONS = [20, 50, 100, 200];

function formatMetadata(value: unknown, fallback: string) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export function AuditLogsContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("settings.manage");
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const [search, setSearch] = useState("");

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<AuditLogEntry[]>("rbac/audit-logs", {
        params: { limit }
      });
      setLogs(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load audit logs", error);
      setErrorMessage(t("auditLogs.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, limit, t]);

  useEffect(() => {
    if (canView) {
      void loadLogs();
    }
  }, [canView, loadLogs]);

  const filteredLogs = useMemo(() => {
    if (!search) {
      return logs;
    }
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return logs;
    }
    return logs.filter((entry) => {
      const haystack = [
        entry.resource,
        entry.action,
        entry.actorId ?? "",
        entry.ipAddress ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [logs, search]);

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("auditLogs.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("auditLogs.adminOnly")}
        />
      </Card>
    );
  }

  const metadataFallback = t("common.emptyValue");

  const columns: ColumnsType<AuditLogEntry> = [
    {
      title: t("auditLogs.columns.time"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) =>
        formatDateTime(value, locale, { dateStyle: "medium", timeStyle: "short" })
    },
    {
      title: t("auditLogs.columns.actor"),
      dataIndex: "actorId",
      key: "actorId",
      render: (value: string | null) => (
        <Typography.Text code>
          {value ?? t("auditLogs.systemActor")}
        </Typography.Text>
      )
    },
    {
      title: t("auditLogs.columns.resource"),
      dataIndex: "resource",
      key: "resource",
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: t("auditLogs.columns.action"),
      dataIndex: "action",
      key: "action",
      render: (value: string) => <Tag color="blue">{value}</Tag>
    },
    {
      title: t("auditLogs.columns.ipAddress"),
      dataIndex: "ipAddress",
      key: "ipAddress",
      render: (value: string | null) => value ?? t("common.emptyValue")
    },
    {
      title: t("auditLogs.columns.metadata"),
      dataIndex: "metadata",
      key: "metadata",
      render: (value: unknown) => (
        <Typography.Paragraph
          style={{ marginBottom: 0 }}
          ellipsis={{ rows: 2, expandable: true, symbol: t("common.view") }}
        >
          {formatMetadata(value, metadataFallback)}
        </Typography.Paragraph>
      )
    }
  ];

  return (
    <Card
      className="content-card"
      title={t("auditLogs.title")}
      extra={
        <Button onClick={() => void loadLogs()} loading={loading}>
          {t("common.refresh")}
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("auditLogs.description")}
        </Typography.Paragraph>
        <Space wrap>
          <Input.Search
            placeholder={t("auditLogs.searchPlaceholder")}
            allowClear
            onSearch={setSearch}
            onChange={(event) => setSearch(event.target.value)}
            value={search}
            style={{ width: 240 }}
          />
          <Select
            value={limit}
            onChange={setLimit}
            options={LIMIT_OPTIONS.map((value) => ({
              value,
              label: t("auditLogs.limitLabel", { count: value })
            }))}
            style={{ width: 140 }}
          />
        </Space>
        {errorMessage ? <Alert type="error" message={errorMessage} showIcon /> : null}
        <Table
          rowKey="id"
          dataSource={filteredLogs}
          columns={columns}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Space>
    </Card>
  );
}
