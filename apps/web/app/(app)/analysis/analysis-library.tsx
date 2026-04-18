"use client";

import {
  DeleteOutlined,
  FolderOpenOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Empty,
  List,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import {
  buildSavedViewHref,
  formatAnalysisActorName,
  type SavedAnalysisSurface,
  type SavedAnalysisView,
} from "@/lib/analysis-workspace";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

type ViewScope = "all" | "mine" | "shared";

export function AnalysisLibrary() {
  const { t, i18n } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [scope, setScope] = useState<ViewScope>("all");
  const [surface, setSurface] = useState<SavedAnalysisSurface | "all">("all");
  const [views, setViews] = useState<SavedAnalysisView[]>([]);
  const [loading, setLoading] = useState(false);
  const locale = resolveLocale(i18n.language);
  const accessToken = session?.accessToken;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canWrite = permissions.includes("analysis.write");
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const loadViews = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (surface !== "all") {
        params.set("surface", surface);
      }
      const response = await apiClient.get<SavedAnalysisView[]>(
        `analysis/views?${params.toString()}`,
      );
      setViews(response.data);
    } catch (error) {
      captureClientError("Failed to load analysis library", error);
      messageApi.error(
        t("analysis.library.loadFailed", {
          defaultValue: "Failed to load saved views.",
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, scope, surface, t]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    void loadViews();
  }, [accessToken, loadViews]);

  const handleCopy = useCallback(
    async (view: SavedAnalysisView) => {
      try {
        await navigator.clipboard.writeText(
          `${window.location.origin}${buildSavedViewHref(view)}`,
        );
        messageApi.success(
          t("analysis.library.copySuccess", {
            defaultValue: "View link copied.",
          }),
        );
      } catch (error) {
        captureClientError("Failed to copy saved view link", error);
        messageApi.error(
          t("analysis.library.copyFailed", {
            defaultValue: "Failed to copy link.",
          }),
        );
      }
    },
    [messageApi, t],
  );

  const handleDelete = useCallback(
    async (viewId: string) => {
      try {
        await apiClient.delete(`analysis/views/${viewId}`);
        setViews((current) => current.filter((entry) => entry.id !== viewId));
        messageApi.success(
          t("analysis.library.deleteSuccess", {
            defaultValue: "Saved view deleted.",
          }),
        );
      } catch (error) {
        captureClientError("Failed to delete saved view", error);
        messageApi.error(
          t("analysis.library.deleteFailed", {
            defaultValue: "Failed to delete saved view.",
          }),
        );
      }
    },
    [apiClient, messageApi, t],
  );

  return (
    <div className="flex flex-col gap-4">
      {contextHolder}
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("analysis.library.title", {
            defaultValue: "Analysis library",
          })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("analysis.library.subtitle", {
            defaultValue:
              "Reopen saved views, copy org-internal links, and manage shared analysis state.",
          })}
        </Typography.Text>
      </Space>

      <Card className="content-card">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <Space wrap>
            <Segmented
              value={scope}
              onChange={(value) => setScope(value as ViewScope)}
              options={[
                { label: t("analysis.library.scope.all", { defaultValue: "All" }), value: "all" },
                { label: t("analysis.library.scope.mine", { defaultValue: "Mine" }), value: "mine" },
                { label: t("analysis.library.scope.shared", { defaultValue: "Shared" }), value: "shared" },
              ]}
            />
            <Select
              style={{ minWidth: 180 }}
              value={surface}
              onChange={(value) => setSurface(value as SavedAnalysisSurface | "all")}
              options={[
                { value: "all", label: t("analysis.library.surface.all", { defaultValue: "All surfaces" }) },
                { value: "search", label: "search" },
                { value: "items", label: "items" },
                { value: "events", label: "events" },
              ]}
            />
          </Space>
          <Button onClick={() => void loadViews()} loading={loading}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        </div>
      </Card>

      <Card className="content-card" loading={loading}>
        {views.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("analysis.library.empty", {
              defaultValue: "No saved views for the current filter.",
            })}
          />
        ) : (
          <List
            itemLayout="vertical"
            dataSource={views}
            renderItem={(view) => (
              <List.Item
                key={view.id}
                actions={[
                  <a key="open" href={buildSavedViewHref(view)}>
                    <FolderOpenOutlined />{" "}
                    {t("analysis.library.open", {
                      defaultValue: "Open view",
                    })}
                  </a>,
                  <Button
                    key="copy"
                    type="link"
                    onClick={() => void handleCopy(view)}
                    icon={<LinkOutlined />}
                  >
                    {t("analysis.library.copy", {
                      defaultValue: "Copy link",
                    })}
                  </Button>,
                  ...(canWrite && view.canEdit
                    ? [
                        <Popconfirm
                          key="delete"
                          title={t("analysis.library.deleteTitle", {
                            defaultValue: "Delete this saved view?",
                          })}
                          onConfirm={() => void handleDelete(view.id)}
                        >
                          <Button
                            type="link"
                            danger
                            icon={<DeleteOutlined />}
                          >
                            {t("common.delete", { defaultValue: "Delete" })}
                          </Button>
                        </Popconfirm>,
                      ]
                    : []),
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space wrap size={[8, 8]}>
                      <Typography.Text strong>{view.title}</Typography.Text>
                      <Tag color="blue">{view.surface}</Tag>
                      <Tag color={view.visibility === "org_shared" ? "gold" : "default"}>
                        {view.visibility}
                      </Tag>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={4}>
                      <Typography.Text type="secondary">
                        {view.description || t("analysis.library.noDescription", {
                          defaultValue: "No description provided.",
                        })}
                      </Typography.Text>
                      <Space wrap size={[8, 4]}>
                        <Tag>{view.routePath}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t("analysis.library.updatedBy", {
                            defaultValue: "Updated by {{name}}",
                            name: formatAnalysisActorName(view.updatedBy),
                          })}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatDateTime(view.updatedAt, locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </Typography.Text>
                      </Space>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
