"use client";

import { Alert, Space, Table, Tag, Typography } from "antd";
import type { TFunction } from "i18next";
import type { ReactElement } from "react";

import { renderGatewayErrorMeta } from "./llm-gateway-test-result";
import type { LlmGatewayProxyLoadBalancingTestResponse } from "./llm-gateway.types";

export function LlmGatewayProxyLbTestResult({
  t,
  result,
}: {
  t: TFunction;
  result: LlmGatewayProxyLoadBalancingTestResponse;
}): ReactElement {
  const total = Math.max(1, result.succeeded + result.failed);
  const modelIdRows = Object.entries(result.modelIdDistribution ?? {})
    .map(([key, count]) => ({
      id: key,
      count,
      ratio: Math.round((count / total) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);
  const apiBaseRows = Object.entries(result.modelApiBaseDistribution ?? {})
    .map(([key, count]) => ({
      id: key,
      count,
      ratio: Math.round((count / total) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);

  return (
    <Space direction="vertical" size="small" style={{ display: "flex" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t("settings.llmGateway.fields.apiBase")}:{" "}
        <Typography.Text code copyable>
          {result.apiBase}
        </Typography.Text>
      </Typography.Paragraph>

      <Space wrap>
        <Tag color="blue">{result.model}</Tag>
        <Tag color={result.failed > 0 ? "red" : "green"}>
          {t("settings.llmGateway.proxyLbTest.summary.success", {
            n: result.succeeded,
          })}
          : {result.succeeded}
        </Tag>
        <Tag color={result.failed > 0 ? "red" : "default"}>
          {t("settings.llmGateway.proxyLbTest.summary.failed")}
          : {result.failed}
        </Tag>
        <Tag>
          {t("settings.llmGateway.proxyLbTest.summary.duration")}
          : {result.durationMs}ms
        </Tag>
        <Tag>
          {t("settings.llmGateway.proxyLbTest.summary.deployments")}
          : {Object.keys(result.modelIdDistribution ?? {}).length}
        </Tag>
        <Tag>
          {t("settings.llmGateway.proxyLbTest.summary.apiBases")}
          : {Object.keys(result.modelApiBaseDistribution ?? {}).length}
        </Tag>
      </Space>

      <Typography.Text type="secondary">
        {t("settings.llmGateway.proxyLbTest.sections.modelIds")}
      </Typography.Text>
      <Table
        size="small"
        rowKey="id"
        dataSource={modelIdRows}
        pagination={{ pageSize: 5, hideOnSinglePage: true }}
        columns={[
          {
            title: t("settings.llmGateway.proxyLbTest.columns.id"),
            dataIndex: "id",
            key: "id",
            render: (value: string) => (
              <Typography.Text code copyable>
                {value}
              </Typography.Text>
            ),
          },
          {
            title: t("settings.llmGateway.proxyLbTest.columns.count"),
            dataIndex: "count",
            key: "count",
            width: 100,
          },
          {
            title: t("settings.llmGateway.proxyLbTest.columns.ratio"),
            dataIndex: "ratio",
            key: "ratio",
            width: 120,
            render: (value: number) => `${value}%`,
          },
        ]}
      />

      <Typography.Text type="secondary">
        {t("settings.llmGateway.proxyLbTest.sections.apiBases")}
      </Typography.Text>
      <Table
        size="small"
        rowKey="id"
        dataSource={apiBaseRows}
        pagination={{ pageSize: 5, hideOnSinglePage: true }}
        columns={[
          {
            title: t("settings.llmGateway.proxyLbTest.columns.apiBase"),
            dataIndex: "id",
            key: "id",
            render: (value: string) => (
              <Typography.Text code copyable>
                {value}
              </Typography.Text>
            ),
          },
          {
            title: t("settings.llmGateway.proxyLbTest.columns.count"),
            dataIndex: "count",
            key: "count",
            width: 100,
          },
          {
            title: t("settings.llmGateway.proxyLbTest.columns.ratio"),
            dataIndex: "ratio",
            key: "ratio",
            width: 120,
            render: (value: number) => `${value}%`,
          },
        ]}
      />

      {result.callIdSamples?.length ? (
        <>
          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyLbTest.sections.callIds")}
          </Typography.Text>
          <Space wrap>
            {result.callIdSamples.map((value) => (
              <Tag key={value}>
                <Typography.Text code copyable>
                  {value}
                </Typography.Text>
              </Tag>
            ))}
          </Space>
        </>
      ) : null}

      {result.errors?.length ? (
        <>
          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyLbTest.sections.errors")}
          </Typography.Text>
          <Space
            direction="vertical"
            size="small"
            style={{ display: "flex" }}
          >
            {result.errors.map((error, idx) => (
              <Alert
                key={`${idx}-${error.message}`}
                type="error"
                showIcon
                message={error.message}
                description={renderGatewayErrorMeta(error)}
              />
            ))}
          </Space>
        </>
      ) : null}
    </Space>
  );
}
