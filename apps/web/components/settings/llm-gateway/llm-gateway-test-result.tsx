"use client";

import { Alert, Space, Tag, Typography } from "antd";
import type { TFunction } from "i18next";
import type { ReactElement } from "react";

import type { LlmGatewayTestResponse } from "./llm-gateway.types";

export function renderGatewayErrorMeta(error: {
  code?: string;
  status?: number;
  axiosCode?: string;
  requestId?: string;
  upstreamType?: string;
  upstreamCode?: string;
  compatibilityError?: {
    code: string;
    incompatibleField: string;
    hint: string;
    upstreamMessage: string;
    status?: number;
  };
}): ReactElement {
  return (
    <Space wrap>
      {error.code ? <Tag color="orange">code: {error.code}</Tag> : null}
      {typeof error.status === "number" ? (
        <Tag color="red">HTTP {error.status}</Tag>
      ) : null}
      {error.upstreamType ? <Tag>type: {error.upstreamType}</Tag> : null}
      {error.upstreamCode ? <Tag>code: {error.upstreamCode}</Tag> : null}
      {error.axiosCode ? <Tag>axios: {error.axiosCode}</Tag> : null}
      {error.requestId ? (
        <Typography.Text type="secondary">
          request-id:{" "}
          <Typography.Text code copyable>
            {error.requestId}
          </Typography.Text>
        </Typography.Text>
      ) : null}
      {error.compatibilityError?.code ? (
        <Tag color="gold">compat: {error.compatibilityError.code}</Tag>
      ) : null}
    </Space>
  );
}

export function LlmGatewayTestResult({
  t,
  result,
}: {
  t: TFunction;
  result: LlmGatewayTestResponse;
}): ReactElement {
  return (
    <Space direction="vertical" size="small" style={{ display: "flex" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t("settings.llmGateway.fields.apiBase")}:{" "}
        <Typography.Text code copyable>
          {result.apiBase}
        </Typography.Text>
      </Typography.Paragraph>

      {result.apiSurfaceUsed ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.test.labels.apiSurface")}
          : <Typography.Text code>{result.apiSurfaceUsed}</Typography.Text>
        </Typography.Paragraph>
      ) : null}

      {result.authModeUsed ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.test.labels.authMode")}
          : <Typography.Text code>{result.authModeUsed}</Typography.Text>
        </Typography.Paragraph>
      ) : null}

      {result.compatibilityError ? (
        <Alert
          type="warning"
          showIcon
          message={`${t("settings.llmGateway.test.labels.compatibility")}: ${result.compatibilityError.code}`}
          description={
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Typography.Text>
                {t("settings.llmGateway.test.labels.field")}
                :{" "}
                <Typography.Text code>
                  {result.compatibilityError.incompatibleField}
                </Typography.Text>
              </Typography.Text>
              <Typography.Text>
                {result.compatibilityError.hint}
              </Typography.Text>
              <Typography.Text
                type="secondary"
                style={{ whiteSpace: "pre-wrap" }}
              >
                {result.compatibilityError.upstreamMessage}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}

      <Typography.Title level={5} style={{ marginBottom: 0 }}>
        {t("settings.llmGateway.test.sections.completion")}
      </Typography.Title>
      {result.completion ? (
        <>
          <Space wrap>
            <Tag color="blue">{result.completion.model}</Tag>
            <Tag>{result.completion.latencyMs}ms</Tag>
            {result.completion.finishReason ? (
              <Tag>{result.completion.finishReason}</Tag>
            ) : null}
            {result.completion.usage ? (
              <Tag>
                {t("settings.llmGateway.test.tokens", {
                  total: result.completion.usage.total_tokens,
                })}
              </Tag>
            ) : null}
            {typeof result.completion.costUsd === "number" ? (
              <Tag color="geekblue">
                {t("settings.llmGateway.test.cost", {
                  cost: result.completion.costUsd.toFixed(6),
                })}
              </Tag>
            ) : null}
          </Space>
          <Typography.Paragraph
            style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}
          >
            {result.completion.content ?? "-"}
          </Typography.Paragraph>
        </>
      ) : result.completionError ? (
        <>
          {renderGatewayErrorMeta(result.completionError)}
          <Alert
            type="error"
            showIcon
            message={result.completionError.message}
          />
          {result.completionError.compatibilityError ? (
            <Alert
              type="warning"
              showIcon
              message={`${t("settings.llmGateway.test.labels.compatibility")}: ${result.completionError.compatibilityError.code}`}
              description={result.completionError.compatibilityError.hint}
            />
          ) : null}
        </>
      ) : (
        <Typography.Text type="secondary">-</Typography.Text>
      )}

      {result.embedding ? (
        <>
          <Typography.Title
            level={5}
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {t("settings.llmGateway.test.sections.embedding")}
          </Typography.Title>
          <Space wrap>
            <Tag color="blue">{result.embedding.model}</Tag>
            <Tag>
              {t("settings.llmGateway.test.dimensions", {
                n: result.embedding.dimensions,
              })}
            </Tag>
            <Tag>{result.embedding.latencyMs}ms</Tag>
            {typeof result.embedding.costUsd === "number" ? (
              <Tag color="geekblue">
                {t("settings.llmGateway.test.cost", {
                  cost: result.embedding.costUsd.toFixed(6),
                })}
              </Tag>
            ) : null}
          </Space>
        </>
      ) : result.embeddingError ? (
        <>
          <Typography.Title
            level={5}
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {t("settings.llmGateway.test.sections.embedding")}
          </Typography.Title>
          {renderGatewayErrorMeta(result.embeddingError)}
          <Alert
            type="error"
            showIcon
            message={result.embeddingError.message}
          />
          {result.embeddingError.compatibilityError ? (
            <Alert
              type="warning"
              showIcon
              message={`${t("settings.llmGateway.test.labels.compatibility")}: ${result.embeddingError.compatibilityError.code}`}
              description={result.embeddingError.compatibilityError.hint}
            />
          ) : null}
        </>
      ) : null}

      {result.rerank ? (
        <>
          <Typography.Title
            level={5}
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {t("settings.llmGateway.test.sections.rerank")}
          </Typography.Title>
          <Space wrap>
            <Tag color="blue">{result.rerank.model}</Tag>
            <Tag>{result.rerank.latencyMs}ms</Tag>
            <Tag>
              {t("settings.llmGateway.test.labels.topN")}
              : {result.rerank.topN}
            </Tag>
            {typeof result.rerank.costUsd === "number" ? (
              <Tag color="geekblue">
                {t("settings.llmGateway.test.cost", {
                  cost: result.rerank.costUsd.toFixed(6),
                })}
              </Tag>
            ) : null}
          </Space>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}
          >
            {result.rerank.results
              .slice(0, 10)
              .map(
                (entry) =>
                  `#${entry.index} ${t(
                    "settings.llmGateway.test.labels.score",
                  )}: ${entry.score.toFixed(4)}`,
              )
              .join("\n")}
          </Typography.Paragraph>
        </>
      ) : result.rerankError ? (
        <>
          <Typography.Title
            level={5}
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {t("settings.llmGateway.test.sections.rerank")}
          </Typography.Title>
          {renderGatewayErrorMeta(result.rerankError)}
          <Alert type="error" showIcon message={result.rerankError.message} />
          {result.rerankError.compatibilityError ? (
            <Alert
              type="warning"
              showIcon
              message={`${t("settings.llmGateway.test.labels.compatibility")}: ${result.rerankError.compatibilityError.code}`}
              description={result.rerankError.compatibilityError.hint}
            />
          ) : null}
        </>
      ) : null}
    </Space>
  );
}
