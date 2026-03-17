"use client";

import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

type CrawlSiteExecutionMode = "layered" | "native" | "hybrid";
type CrawlFrontierRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
type CrawlFrontierNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";

interface CrawlSiteProfileRecord {
  id: string;
  name: string;
  description?: string | null;
  matchHost: string;
  isActive: boolean;
  executionMode: CrawlSiteExecutionMode;
  version: number;
  config: Record<string, unknown>;
  updatedAt: string;
}

interface CrawlSiteProfileVersionRecord {
  id: string;
  version: number;
  name: string;
  executionMode: CrawlSiteExecutionMode;
  createdAt: string;
  createdById: string;
}

interface CrawlFrontierRunRecord {
  id: string;
  seedUrl: string;
  executionMode: CrawlSiteExecutionMode;
  status: CrawlFrontierRunStatus;
  maxDepth: number;
  maxPages: number;
  pageCount: number;
  nodeCount: number;
  articleCount: number;
  failedCount: number;
  duplicateCount: number;
  createdAt: string;
  profile?: {
    id: string;
    name: string;
    matchHost: string;
  } | null;
}

interface CrawlFrontierNodeRecord {
  id: string;
  url: string;
  pageType: string;
  depth: number;
  queueClass: string;
  status: CrawlFrontierNodeStatus;
  attempts: number;
  score?: number | null;
  freshnessScore?: number | null;
  lastError?: string | null;
  rejectionReason?: string | null;
  discoveredAt: string;
  crawledAt?: string | null;
}

interface CrawlFrontierRunDetail extends CrawlFrontierRunRecord {
  nodes: CrawlFrontierNodeRecord[];
}

interface ProfileFormValues {
  name: string;
  description?: string;
  matchHost: string;
  isActive: boolean;
  executionMode: CrawlSiteExecutionMode;
  configJson: string;
}

interface RunFormValues {
  seedUrl: string;
  profileId?: string;
  executionMode?: CrawlSiteExecutionMode;
  maxDepth?: number;
  maxPages?: number;
  keywordsText?: string;
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function parseJsonObject(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : `${label} must be a valid JSON object`,
    );
  }
}

function parseKeywords(value?: string) {
  return (value ?? "")
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function extractErrorMessage(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response &&
    error.response.data &&
    typeof error.response.data === "object"
  ) {
    const data = error.response.data as Record<string, unknown>;
    if (typeof data.message === "string" && data.message.trim().length > 0) {
      return data.message.trim();
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

const runStatusColors: Record<CrawlFrontierRunStatus, string> = {
  pending: "default",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  canceled: "default",
};

const nodeStatusColors: Record<CrawlFrontierNodeStatus, string> = {
  pending: "default",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  skipped: "gold",
  canceled: "default",
};

export function CrawlFrontierContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<CrawlSiteProfileRecord[]>([]);
  const [runs, setRuns] = useState<CrawlFrontierRunRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<CrawlFrontierRunDetail | null>(
    null,
  );
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<CrawlSiteProfileVersionRecord[]>([]);
  const [currentVersionProfile, setCurrentVersionProfile] =
    useState<CrawlSiteProfileRecord | null>(null);
  const [profileModal, setProfileModal] = useState<{
    open: boolean;
    editing: CrawlSiteProfileRecord | null;
  }>({ open: false, editing: null });
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [runForm] = Form.useForm<RunFormValues>();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadProfiles = useCallback(async () => {
    if (!canView) {
      return;
    }
    setLoadingProfiles(true);
    try {
      const response = await apiClient.get<CrawlSiteProfileRecord[]>(
        "admin/crawl-frontier/profiles",
      );
      setProfiles(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl frontier profiles", error);
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadProfiles", {
            defaultValue: "Failed to load crawl site profiles.",
          }),
        ),
      );
    } finally {
      setLoadingProfiles(false);
    }
  }, [apiClient, canView, messageApi, t]);

  const loadRuns = useCallback(async () => {
    if (!canView) {
      return;
    }
    setLoadingRuns(true);
    try {
      const response = await apiClient.get<CrawlFrontierRunRecord[]>(
        "admin/crawl-frontier/runs",
      );
      setRuns(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl frontier runs", error);
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadRuns", {
            defaultValue: "Failed to load crawl frontier runs.",
          }),
        ),
      );
    } finally {
      setLoadingRuns(false);
    }
  }, [apiClient, canView, messageApi, t]);

  useEffect(() => {
    if (canView) {
      void Promise.all([loadProfiles(), loadRuns()]);
    }
  }, [canView, loadProfiles, loadRuns]);

  const openCreateProfile = () => {
    profileForm.setFieldsValue({
      name: "",
      description: "",
      matchHost: "",
      isActive: true,
      executionMode: "layered",
      configJson: stringifyJson({
        keywords: [],
        blockedDomains: [],
        urlPatterns: {
          home: [],
          category: [],
          list: [],
          article: [],
          exclude: [],
        },
        layeredOptions: {
          maxDepth: 3,
          maxPages: 60,
          maxChildrenPerNode: 24,
          paginationKeepCount: 3,
          scoreThreshold: 0.35,
        },
      }),
    });
    setProfileModal({ open: true, editing: null });
  };

  const openEditProfile = (profile: CrawlSiteProfileRecord) => {
    profileForm.setFieldsValue({
      name: profile.name,
      description: profile.description ?? "",
      matchHost: profile.matchHost,
      isActive: profile.isActive,
      executionMode: profile.executionMode,
      configJson: stringifyJson(profile.config),
    });
    setProfileModal({ open: true, editing: profile });
  };

  const submitProfile = async (values: ProfileFormValues) => {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        matchHost: values.matchHost.trim(),
        isActive: values.isActive,
        executionMode: values.executionMode,
        config: parseJsonObject(values.configJson, "config"),
      };
      if (profileModal.editing) {
        await apiClient.patch(
          `admin/crawl-frontier/profiles/${profileModal.editing.id}`,
          payload,
        );
      } else {
        await apiClient.post("admin/crawl-frontier/profiles", payload);
      }
      messageApi.success(
        t("crawlFrontier.messages.profileSaved", {
          defaultValue: "Crawl site profile saved.",
        }),
      );
      setProfileModal({ open: false, editing: null });
      await loadProfiles();
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.saveProfile", {
            defaultValue: "Failed to save crawl site profile.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const openVersions = async (profile: CrawlSiteProfileRecord) => {
    setSaving(true);
    try {
      const response = await apiClient.get<CrawlSiteProfileVersionRecord[]>(
        `admin/crawl-frontier/profiles/${profile.id}/versions`,
      );
      setVersions(response.data ?? []);
      setCurrentVersionProfile(profile);
      setVersionsOpen(true);
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadVersions", {
            defaultValue: "Failed to load crawl site profile versions.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const rollbackVersion = async (profileId: string, version: number) => {
    setSaving(true);
    try {
      await apiClient.post(
        `admin/crawl-frontier/profiles/${profileId}/rollback/${version}`,
      );
      messageApi.success(
        t("crawlFrontier.messages.profileRolledBack", {
          defaultValue: "Crawl site profile rolled back.",
        }),
      );
      setVersionsOpen(false);
      setCurrentVersionProfile(null);
      await loadProfiles();
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.rollbackProfile", {
            defaultValue: "Failed to roll back crawl site profile.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const submitRun = async (values: RunFormValues) => {
    setSaving(true);
    try {
      const payload = {
        seedUrl: values.seedUrl.trim(),
        profileId: values.profileId || undefined,
        executionMode: values.executionMode || undefined,
        maxDepth: values.maxDepth,
        maxPages: values.maxPages,
        keywords: parseKeywords(values.keywordsText),
      };
      await apiClient.post("admin/crawl-frontier/runs", payload);
      messageApi.success(
        t("crawlFrontier.messages.runCreated", {
          defaultValue: "Crawl frontier run created.",
        }),
      );
      setRunModalOpen(false);
      runForm.resetFields();
      await loadRuns();
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.createRun", {
            defaultValue: "Failed to create crawl frontier run.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const openRun = async (runId: string) => {
    setSaving(true);
    try {
      const response = await apiClient.get<CrawlFrontierRunDetail>(
        `admin/crawl-frontier/runs/${runId}`,
      );
      setSelectedRun(response.data);
      setRunDrawerOpen(true);
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.loadRun", {
            defaultValue: "Failed to load crawl frontier run.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const cancelRun = async (runId: string) => {
    setSaving(true);
    try {
      await apiClient.post(`admin/crawl-frontier/runs/${runId}/cancel`);
      messageApi.success(
        t("crawlFrontier.messages.runCanceled", {
          defaultValue: "Crawl frontier run canceled.",
        }),
      );
      if (selectedRun?.id === runId) {
        setRunDrawerOpen(false);
        setSelectedRun(null);
      }
      await loadRuns();
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.cancelRun", {
            defaultValue: "Failed to cancel crawl frontier run.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const retryNode = async (nodeId: string) => {
    setSaving(true);
    try {
      const response = await apiClient.post<CrawlFrontierRunDetail>(
        `admin/crawl-frontier/nodes/${nodeId}/retry`,
      );
      setSelectedRun(response.data);
      messageApi.success(
        t("crawlFrontier.messages.nodeRetried", {
          defaultValue: "Crawl frontier node re-queued.",
        }),
      );
      await loadRuns();
    } catch (error) {
      messageApi.error(
        extractErrorMessage(
          error,
          t("crawlFrontier.errors.retryNode", {
            defaultValue: "Failed to retry crawl frontier node.",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const profileColumns: ColumnsType<CrawlSiteProfileRecord> = [
    {
      title: t("crawlFrontier.profile.columns.name", { defaultValue: "Name" }),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("crawlFrontier.profile.columns.matchHost", {
        defaultValue: "Match Host",
      }),
      dataIndex: "matchHost",
      key: "matchHost",
    },
    {
      title: t("crawlFrontier.profile.columns.mode", { defaultValue: "Mode" }),
      dataIndex: "executionMode",
      key: "executionMode",
      render: (value: CrawlSiteExecutionMode) => <Tag>{value}</Tag>,
    },
    {
      title: t("crawlFrontier.profile.columns.status", {
        defaultValue: "Status",
      }),
      key: "isActive",
      render: (_, record) =>
        record.isActive ? (
          <Tag color="green">
            {t("crawlFrontier.profile.active", { defaultValue: "Active" })}
          </Tag>
        ) : (
          <Tag>
            {t("crawlFrontier.profile.inactive", { defaultValue: "Inactive" })}
          </Tag>
        ),
    },
    {
      title: t("crawlFrontier.profile.columns.version", {
        defaultValue: "Version",
      }),
      dataIndex: "version",
      key: "version",
      width: 100,
    },
    {
      title: t("crawlFrontier.profile.columns.actions", {
        defaultValue: "Actions",
      }),
      key: "actions",
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => openEditProfile(record)}>
            {t("common.edit", { defaultValue: "Edit" })}
          </Button>
          <Button size="small" onClick={() => void openVersions(record)}>
            {t("crawlFrontier.profile.versions", { defaultValue: "Versions" })}
          </Button>
        </Space>
      ),
    },
  ];

  const runColumns: ColumnsType<CrawlFrontierRunRecord> = [
    {
      title: t("crawlFrontier.runs.columns.seedUrl", {
        defaultValue: "Seed URL",
      }),
      dataIndex: "seedUrl",
      key: "seedUrl",
      ellipsis: true,
    },
    {
      title: t("crawlFrontier.runs.columns.profile", {
        defaultValue: "Profile",
      }),
      key: "profile",
      render: (_, record) => record.profile?.name ?? "auto",
    },
    {
      title: t("crawlFrontier.runs.columns.mode", { defaultValue: "Mode" }),
      dataIndex: "executionMode",
      key: "executionMode",
      render: (value: CrawlSiteExecutionMode) => <Tag>{value}</Tag>,
    },
    {
      title: t("crawlFrontier.runs.columns.status", {
        defaultValue: "Status",
      }),
      dataIndex: "status",
      key: "status",
      render: (value: CrawlFrontierRunStatus) => (
        <Tag color={runStatusColors[value]}>{value}</Tag>
      ),
    },
    {
      title: t("crawlFrontier.runs.columns.coverage", {
        defaultValue: "Coverage",
      }),
      key: "coverage",
      render: (_, record) =>
        `${record.pageCount}/${record.nodeCount} pages, ${record.articleCount} articles`,
    },
    {
      title: t("crawlFrontier.runs.columns.actions", {
        defaultValue: "Actions",
      }),
      key: "actions",
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => void openRun(record.id)}>
            {t("common.view", { defaultValue: "View" })}
          </Button>
          {record.status !== "completed" && record.status !== "canceled" ? (
            <Button size="small" danger onClick={() => void cancelRun(record.id)}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const nodeColumns: ColumnsType<CrawlFrontierNodeRecord> = [
    {
      title: t("crawlFrontier.nodes.columns.url", { defaultValue: "URL" }),
      dataIndex: "url",
      key: "url",
      ellipsis: true,
    },
    {
      title: t("crawlFrontier.nodes.columns.pageType", {
        defaultValue: "Page Type",
      }),
      dataIndex: "pageType",
      key: "pageType",
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: t("crawlFrontier.nodes.columns.depth", { defaultValue: "Depth" }),
      dataIndex: "depth",
      key: "depth",
      width: 80,
    },
    {
      title: t("crawlFrontier.nodes.columns.status", {
        defaultValue: "Status",
      }),
      dataIndex: "status",
      key: "status",
      render: (value: CrawlFrontierNodeStatus) => (
        <Tag color={nodeStatusColors[value]}>{value}</Tag>
      ),
    },
    {
      title: t("crawlFrontier.nodes.columns.score", { defaultValue: "Score" }),
      key: "score",
      render: (_, record) =>
        typeof record.score === "number"
          ? record.score.toFixed(2)
          : typeof record.freshnessScore === "number"
            ? `fresh ${record.freshnessScore.toFixed(2)}`
            : "-",
    },
    {
      title: t("crawlFrontier.nodes.columns.error", { defaultValue: "Error" }),
      key: "error",
      render: (_, record) => record.lastError ?? record.rejectionReason ?? "-",
      ellipsis: true,
    },
    {
      title: t("crawlFrontier.nodes.columns.actions", {
        defaultValue: "Actions",
      }),
      key: "actions",
      render: (_, record) =>
        record.status === "failed" || record.status === "skipped" ? (
          <Button size="small" onClick={() => void retryNode(record.id)}>
            {t("common.retry", { defaultValue: "Retry" })}
          </Button>
        ) : null,
    },
  ];

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card">
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("crawlFrontier.title", { defaultValue: "Crawl Frontier" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("crawlFrontier.subtitle", {
            defaultValue:
              "Manage database-driven crawl site profiles and layered/native frontier runs.",
          })}
        </Typography.Text>
      </Space>

      <Tabs
        items={[
          {
            key: "profiles",
            label: t("crawlFrontier.tabs.profiles", {
              defaultValue: "Profiles",
            }),
            children: (
              <Card
                className="content-card"
                extra={
                  canManage ? (
                    <Button type="primary" onClick={openCreateProfile}>
                      {t("crawlFrontier.profile.create", {
                        defaultValue: "New Profile",
                      })}
                    </Button>
                  ) : null
                }
              >
                <Table
                  rowKey="id"
                  columns={profileColumns}
                  dataSource={profiles}
                  loading={loadingProfiles}
                  pagination={{ pageSize: 10 }}
                  locale={{ emptyText: <Empty description={t("common.empty")} /> }}
                />
              </Card>
            ),
          },
          {
            key: "runs",
            label: t("crawlFrontier.tabs.runs", { defaultValue: "Runs" }),
            children: (
              <Card
                className="content-card"
                extra={
                  canManage ? (
                    <Button
                      type="primary"
                      onClick={() => {
                        runForm.setFieldsValue({
                          executionMode: "layered",
                          maxDepth: 3,
                          maxPages: 60,
                        });
                        setRunModalOpen(true);
                      }}
                    >
                      {t("crawlFrontier.runs.create", {
                        defaultValue: "New Run",
                      })}
                    </Button>
                  ) : null
                }
              >
                <Table
                  rowKey="id"
                  columns={runColumns}
                  dataSource={runs}
                  loading={loadingRuns}
                  pagination={{ pageSize: 10 }}
                  locale={{ emptyText: <Empty description={t("common.empty")} /> }}
                />
              </Card>
            ),
          },
        ]}
      />

      <Modal
        open={profileModal.open}
        title={
          profileModal.editing
            ? t("crawlFrontier.profile.editTitle", {
                defaultValue: "Edit Crawl Site Profile",
              })
            : t("crawlFrontier.profile.createTitle", {
                defaultValue: "Create Crawl Site Profile",
              })
        }
        onCancel={() => setProfileModal({ open: false, editing: null })}
        onOk={() => void profileForm.submit()}
        okButtonProps={{ loading: saving, disabled: !canManage }}
        destroyOnClose
        width={820}
      >
        <Form layout="vertical" form={profileForm} onFinish={submitProfile}>
          <Form.Item
            name="name"
            label={t("crawlFrontier.profile.fields.name", {
              defaultValue: "Name",
            })}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="description"
            label={t("crawlFrontier.profile.fields.description", {
              defaultValue: "Description",
            })}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="matchHost"
            label={t("crawlFrontier.profile.fields.matchHost", {
              defaultValue: "Match Host",
            })}
            rules={[{ required: true }]}
          >
            <Input placeholder="*.example.com" />
          </Form.Item>
          <Form.Item
            name="executionMode"
            label={t("crawlFrontier.profile.fields.executionMode", {
              defaultValue: "Execution Mode",
            })}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { label: "layered", value: "layered" },
                { label: "native", value: "native" },
                { label: "hybrid", value: "hybrid" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="isActive"
            valuePropName="checked"
            label={t("crawlFrontier.profile.fields.isActive", {
              defaultValue: "Active",
            })}
          >
            <Switch
              checkedChildren={t("common.enabled", { defaultValue: "Enabled" })}
              unCheckedChildren={t("common.disabled", {
                defaultValue: "Disabled",
              })}
            />
          </Form.Item>
          <Form.Item
            name="configJson"
            label={t("crawlFrontier.profile.fields.config", {
              defaultValue: "Config JSON",
            })}
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={16} spellCheck={false} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={versionsOpen}
        title={t("crawlFrontier.profile.versionsTitle", {
          defaultValue: "Profile Versions",
        })}
        onCancel={() => {
          setVersionsOpen(false);
          setCurrentVersionProfile(null);
        }}
        footer={null}
        destroyOnClose
      >
        <Table
          rowKey="id"
          dataSource={versions}
          pagination={false}
          columns={[
            { title: "Version", dataIndex: "version", key: "version" },
            { title: "Mode", dataIndex: "executionMode", key: "executionMode" },
            { title: "Created", dataIndex: "createdAt", key: "createdAt" },
            {
              title: "Actions",
              key: "actions",
              render: (_, record) =>
                currentVersionProfile ? (
                  <Button
                    size="small"
                    onClick={() =>
                      void rollbackVersion(currentVersionProfile.id, record.version)
                    }
                  >
                    {t("crawlFrontier.profile.rollback", {
                      defaultValue: "Rollback",
                    })}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Modal>

      <Modal
        open={runModalOpen}
        title={t("crawlFrontier.runs.createTitle", {
          defaultValue: "Create Crawl Frontier Run",
        })}
        onCancel={() => setRunModalOpen(false)}
        onOk={() => void runForm.submit()}
        okButtonProps={{ loading: saving, disabled: !canManage }}
        destroyOnClose
      >
        <Form layout="vertical" form={runForm} onFinish={submitRun}>
          <Form.Item
            name="seedUrl"
            label={t("crawlFrontier.runs.fields.seedUrl", {
              defaultValue: "Seed URL",
            })}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="profileId"
            label={t("crawlFrontier.runs.fields.profile", {
              defaultValue: "Profile",
            })}
            extra={t("crawlFrontier.runs.fields.profileHint", {
              defaultValue: "Leave empty to auto-match by host.",
            })}
          >
            <Select
              allowClear
              options={profiles.map((profile) => ({
                label: `${profile.name} (${profile.matchHost})`,
                value: profile.id,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="executionMode"
            label={t("crawlFrontier.runs.fields.executionMode", {
              defaultValue: "Execution Mode Override",
            })}
          >
            <Select
              allowClear
              options={[
                { label: "layered", value: "layered" },
                { label: "native", value: "native" },
                { label: "hybrid", value: "hybrid" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="maxDepth"
            label={t("crawlFrontier.runs.fields.maxDepth", {
              defaultValue: "Max Depth",
            })}
          >
            <InputNumber min={1} max={8} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="maxPages"
            label={t("crawlFrontier.runs.fields.maxPages", {
              defaultValue: "Max Pages",
            })}
          >
            <InputNumber min={1} max={500} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="keywordsText"
            label={t("crawlFrontier.runs.fields.keywords", {
              defaultValue: "Keywords",
            })}
            extra={t("crawlFrontier.runs.fields.keywordsHint", {
              defaultValue: "Comma or newline separated.",
            })}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={t("crawlFrontier.runs.detailTitle", {
          defaultValue: "Crawl Frontier Run Detail",
        })}
        open={runDrawerOpen}
        onClose={() => {
          setRunDrawerOpen(false);
          setSelectedRun(null);
        }}
        width={1080}
      >
        {selectedRun ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card size="small">
              <Space wrap size="middle">
                <Tag color={runStatusColors[selectedRun.status]}>
                  {selectedRun.status}
                </Tag>
                <Typography.Text>{selectedRun.seedUrl}</Typography.Text>
                <Typography.Text type="secondary">
                  {selectedRun.profile?.name ?? "auto"} / {selectedRun.executionMode}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {selectedRun.pageCount} pages, {selectedRun.nodeCount} nodes,{" "}
                  {selectedRun.articleCount} articles
                </Typography.Text>
              </Space>
            </Card>
            <Table
              rowKey="id"
              columns={nodeColumns}
              dataSource={selectedRun.nodes}
              pagination={{ pageSize: 20 }}
            />
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
