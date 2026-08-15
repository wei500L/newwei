"use client";

import { Modal, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TFunction } from "i18next";

import type { LlmGatewayProxyModelInfoEntry, LlmGatewayProxyModelInfoResponse } from "./llm-gateway.types";

export function openLlmGatewayModelsModal(
  t: TFunction,
  screensMd: boolean | undefined,
  title: string,
  apiBase: string,
  models: string[],
): void {
  interface ModelRow {
    id: string;
  }
  const rows: ModelRow[] = models.map((id) => ({ id }));
  const columns: ColumnsType<ModelRow> = [
    {
      title: t("settings.llmGateway.models.columns.id"),
      dataIndex: "id",
      key: "id",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      ),
    },
  ];

  Modal.info({
    title,
    width: screensMd ? 720 : "100%",
    content: (
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.fields.apiBase")}:{" "}
          <Typography.Text code copyable>
            {apiBase}
          </Typography.Text>
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          {t("settings.llmGateway.models.count", { count: models.length })}
        </Typography.Text>
        <Table<ModelRow>
          size="small"
          rowKey="id"
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ y: 360 }}
          locale={{ emptyText: t("common.empty") }}
        />
      </Space>
    ),
  });
}

export function openLlmGatewayProxyModelInfoModal(
  t: TFunction,
  screensMd: boolean | undefined,
  title: string,
  apiBase: string,
  result: LlmGatewayProxyModelInfoResponse,
): void {
  interface ModelInfoRow {
    id: string;
    modelName: string;
    deployments: number;
    providerModels: string[];
    apiBases: string[];
    rpms: number[];
    tpms: number[];
  }

  const groups = new Map<string, LlmGatewayProxyModelInfoEntry[]>();
  for (const model of result.models ?? []) {
    const key = model.modelName;
    const next = groups.get(key) ?? [];
    next.push(model);
    groups.set(key, next);
  }

  const rows: ModelInfoRow[] = Array.from(groups.entries()).map(
    ([modelName, entries]) => {
      const providerModels = Array.from(
        new Set(
          entries
            .map((entry) => entry.litellmParams?.["model"])
            .filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
            .map((value) => value.trim()),
        ),
      );
      const apiBases = Array.from(
        new Set(
          entries
            .map((entry) => entry.litellmParams?.["api_base"])
            .filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
            .map((value) => value.trim()),
        ),
      );
      const rpms = Array.from(
        new Set(
          entries
            .map((entry) => entry.litellmParams?.["rpm"])
            .filter(
              (value): value is number =>
                typeof value === "number" && Number.isFinite(value),
            ),
        ),
      ).sort((a, b) => a - b);
      const tpms = Array.from(
        new Set(
          entries
            .map((entry) => entry.litellmParams?.["tpm"])
            .filter(
              (value): value is number =>
                typeof value === "number" && Number.isFinite(value),
            ),
        ),
      ).sort((a, b) => a - b);

      return {
        id: modelName,
        modelName,
        deployments: entries.length,
        providerModels,
        apiBases,
        rpms,
        tpms,
      };
    },
  );

  const totalDeployments = rows.reduce(
    (acc, row) => acc + row.deployments,
    0,
  );

  const columns: ColumnsType<ModelInfoRow> = [
    {
      title: t("settings.llmGateway.proxyModelInfo.columns.model"),
      dataIndex: "modelName",
      key: "modelName",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t("settings.llmGateway.proxyModelInfo.columns.deployments"),
      dataIndex: "deployments",
      key: "deployments",
      width: 140,
      render: (value: number) => (
        <Tag color={value > 1 ? "green" : "default"}>{value}</Tag>
      ),
    },
    {
      title: t("settings.llmGateway.proxyModelInfo.columns.details"),
      key: "details",
      render: (_: unknown, record: ModelInfoRow) => {
        const parts: string[] = [];
        if (record.providerModels.length > 0) {
          parts.push(`model: ${record.providerModels.join(", ")}`);
        }
        if (record.apiBases.length > 0) {
          parts.push(`api_base: ${record.apiBases.join(", ")}`);
        }
        if (record.rpms.length > 0) {
          parts.push(`rpm: ${record.rpms.join(", ")}`);
        }
        if (record.tpms.length > 0) {
          parts.push(`tpm: ${record.tpms.join(", ")}`);
        }
        return (
          <Typography.Text type="secondary">
            {parts.length > 0 ? parts.join(" | ") : "-"}
          </Typography.Text>
        );
      },
    },
  ];

  Modal.info({
    title,
    width: screensMd ? 860 : "100%",
    content: (
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.fields.apiBase")}:{" "}
          <Typography.Text code copyable>
            {apiBase}
          </Typography.Text>
        </Typography.Paragraph>

        <Typography.Text type="secondary">
          {t("settings.llmGateway.proxyModelInfo.summary", {
            groups: rows.length,
            deployments: totalDeployments,
          })}
        </Typography.Text>

        <Typography.Text type="secondary">
          {t("settings.llmGateway.proxyModelInfo.hint")}
        </Typography.Text>

        <Table<ModelInfoRow>
          size="small"
          rowKey="id"
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
          scroll={{ y: 420 }}
          locale={{ emptyText: t("common.empty") }}
        />
      </Space>
    ),
  });
}
