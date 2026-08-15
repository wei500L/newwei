"use client";

import { Alert, Button, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { LlmGatewayProfile } from "./llm-gateway.types";
import type { LlmGatewaySettingsController } from "./use-llm-gateway-settings";

export function LlmGatewayProfilesPanel({
  s,
}: {
  s: LlmGatewaySettingsController;
}): ReactElement {
  const { t } = useTranslation();
  const {
    settings,
    screens,
    loading,
    errorMessage,
    openCreate,
    loadSettings,
    toggling,
    activatingProfileId,
    handleToggle,
    handleActivate,
    handleDelete,
    openTest,
    setEditing,
    isGovernedProfileLocked,
    testing,
    handleListModels,
    loadingModels,
  } = s;

  const columns: ColumnsType<LlmGatewayProfile> = [
    {
      title: t("settings.llmGateway.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, record) => {
        const governed = isGovernedProfileLocked(record.id);
        return (
          <Space direction="vertical" size={2}>
            <Space size={6} wrap>
              <Typography.Text strong>{record.name}</Typography.Text>
              {settings.activeId === record.id && record.enabled ? (
                <Tag color="blue">{t("settings.llmGateway.active")}</Tag>
              ) : null}
              {settings.embeddingActiveId === record.id && record.enabled ? (
                <Tag color="purple">
                  {t("settings.llmGateway.embeddingActive.tag")}
                </Tag>
              ) : null}
              {settings.rerankActiveId === record.id && record.enabled ? (
                <Tag color="gold">
                  {t("settings.llmGateway.rerankActive.tag")}
                </Tag>
              ) : null}
              {governed ? (
                <Tag color="geekblue">
                  {t("settings.llmGateway.proxyGovernance.table.lockedTag")}
                </Tag>
              ) : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Typography.Text code copyable>
                {record.apiBase}
              </Typography.Text>
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("settings.llmGateway.columns.model"),
      dataIndex: "model",
      key: "model",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t("settings.llmGateway.columns.assistantModel"),
      dataIndex: "assistantModel",
      key: "assistantModel",
      responsive: ["xl"],
      render: (value?: string | null) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t("settings.llmGateway.columns.embeddingModel"),
      dataIndex: "embeddingModel",
      key: "embeddingModel",
      responsive: ["lg"],
      render: (value?: string | null) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t("settings.llmGateway.columns.rerankModel"),
      dataIndex: "rerankModel",
      key: "rerankModel",
      responsive: ["xl"],
      render: (value?: string | null) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t("settings.llmGateway.columns.compatibility"),
      key: "compatibility",
      responsive: ["xl"],
      render: (_: unknown, record) => (
        <Space wrap>
          <Tag>{`api:${record.apiSurface}`}</Tag>
          <Tag color={record.assistantWebSearchEnabled ? "blue" : "default"}>
            {record.assistantWebSearchEnabled
              ? t("settings.llmGateway.columns.assistantWebSearchOn")
              : t("settings.llmGateway.columns.assistantWebSearchOff")}
          </Tag>
          <Tag>{`response_format:${record.responseFormatMode}`}</Tag>
          <Tag color={record.sendMetadata ? "green" : "default"}>
            {record.sendMetadata
              ? t("settings.llmGateway.columns.metadataOn")
              : t("settings.llmGateway.columns.metadataOff")}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("settings.llmGateway.columns.status"),
      dataIndex: "enabled",
      key: "enabled",
      render: (value: boolean, record) => (
        <Space wrap>
          <Tag color={value ? "green" : "red"}>
            {value ? t("common.enabled") : t("common.disabled")}
          </Tag>
          {isGovernedProfileLocked(record.id) ? (
            <Tag color="gold">
              {t("settings.llmGateway.proxyGovernance.table.lockedStatus")}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("settings.llmGateway.columns.apiKey"),
      dataIndex: "hasApiKey",
      key: "hasApiKey",
      responsive: ["md"],
      render: (value: boolean) => (
        <Tag color={value ? "green" : "default"}>
          {value
            ? t("settings.llmGateway.keySet")
            : t("settings.llmGateway.keyMissing")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, record) => {
        const governed = isGovernedProfileLocked(record.id);
        const governedHint = governed
          ? t("settings.llmGateway.proxyGovernance.table.lockedHint")
          : undefined;
        return (
          <Space wrap>
            <Button
              size="small"
              onClick={() => openTest(record)}
              loading={testing === record.id}
            >
              {t("settings.llmGateway.actions.test")}
            </Button>
            <Button
              size="small"
              onClick={() => void handleListModels(record)}
              loading={loadingModels === record.id}
            >
              {t("settings.llmGateway.actions.models")}
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={
                settings.activeId === record.id ||
                !record.enabled ||
                (activatingProfileId !== null &&
                  activatingProfileId !== record.id)
              }
              loading={activatingProfileId === record.id}
              onClick={() => void handleActivate(record.id)}
            >
              {t("settings.llmGateway.actions.activate")}
            </Button>
            <Tooltip title={governedHint}>
              <span>
                <Button
                  size="small"
                  disabled={governed}
                  onClick={() => setEditing(record)}
                >
                  {t("common.edit")}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={governedHint}>
              <span>
                <Button
                  size="small"
                  danger
                  disabled={governed}
                  onClick={() => handleDelete(record)}
                >
                  {t("common.delete")}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={governedHint}>
              <span>
                <Switch
                  size="small"
                  checked={record.enabled}
                  disabled={governed}
                  loading={toggling === record.id}
                  onChange={(checked) => void handleToggle(record, checked)}
                />
              </span>
            </Tooltip>
          </Space>
        );
      },
    },
  ];


  return (
    <Space direction="vertical" size="middle" style={{ display: "flex" }}>
    {errorMessage ? (
      <Alert type="error" showIcon message={errorMessage} />
    ) : null}

    <Space wrap>
      <Button type="primary" htmlType="button" onClick={openCreate}>
        {t("settings.llmGateway.actions.new")}
      </Button>
      <Button onClick={() => void loadSettings()} loading={loading}>
        {t("common.refresh")}
      </Button>
    </Space>

    <Table<LlmGatewayProfile>
      rowKey="id"
      size={screens.lg ? "middle" : "small"}
      loading={loading}
      dataSource={settings.profiles}
      columns={columns}
      pagination={false}
      locale={{ emptyText: t("common.empty") }}
    />
    </Space>
  );
}
