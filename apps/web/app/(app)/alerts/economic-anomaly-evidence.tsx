import { Alert, Card, Descriptions, Space, Tag, Tooltip, Typography } from "antd";

import { RANGE_INDICATOR_COLORS } from "@/lib/status-tokens";

import {
  formatEvidenceTimestamp,
  isRecord,
  safeJsonStringify,
  toNumber,
  toStringValue,
  type LocaleCode,
  type TranslateFn,
} from "./evidence-utils";

/**
 * economic_anomaly 证据渲染（FE-批3 从 alert-center.tsx 原样迁出）。
 * 行为与视觉保持不变：评分 Tag、期望/残差/CI 描述、CI 区间可视化。
 */
export function EconomicAnomalyEvidence({
  context,
  locale,
  t,
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
}) {
  if (!context) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty")}
      </Typography.Text>
    );
  }

  const itemName = toStringValue(context.itemName);
  const recordedAt =
    typeof context.recordedAt === "string" ||
    typeof context.recordedAt === "number"
      ? context.recordedAt
      : undefined;
  const recordedAtLabel = formatEvidenceTimestamp(recordedAt, locale);

  const model = isRecord(context.model) ? context.model : null;
  const modelKind = toStringValue(model?.kind);
  const observed = toNumber(context.observed);
  const expected = toNumber(context.expected);
  const lower = toNumber(context.lower);
  const upper = toNumber(context.upper);
  const sigma = toNumber(context.sigma);
  const residual = toNumber(context.residual);
  const score = toNumber(context.score);
  const fallback = isRecord(context.fallback) ? context.fallback : null;
  const canRenderCiRange =
    typeof lower === "number" &&
    typeof upper === "number" &&
    typeof observed === "number" &&
    typeof expected === "number" &&
    upper > lower;
  const ciMin = canRenderCiRange ? Math.min(lower, observed, expected) : 0;
  const ciMax = canRenderCiRange ? Math.max(upper, observed, expected) : 0;
  const ciSpan = canRenderCiRange ? ciMax - ciMin : 0;
  const toPercentPosition = (value: number) =>
    ciSpan > 0
      ? Math.max(0, Math.min(100, ((value - ciMin) / ciSpan) * 100))
      : 50;

  const scoreColor =
    typeof score === "number"
      ? score >= 3
        ? "red"
        : score >= 2
          ? "orange"
          : "green"
      : "default";

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {itemName ? <Tag>{itemName}</Tag> : null}
        {modelKind ? <Tag color="blue">{modelKind}</Tag> : null}
        {typeof score === "number" ? (
          <Tag color={scoreColor}>{`score ${score.toFixed(3)}`}</Tag>
        ) : null}
        {recordedAtLabel ? <Tag>{recordedAtLabel}</Tag> : null}
      </Space>

      {typeof expected === "number" && typeof sigma === "number" ? (
        <>
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label={t("alerts.center.evidence.observed")}>
              {typeof observed === "number"
                ? observed
                : t("common.notAvailable")}
            </Descriptions.Item>
            <Descriptions.Item label={t("alerts.center.evidence.expected")}>
              {expected}
            </Descriptions.Item>
            <Descriptions.Item label={t("alerts.center.evidence.residual")}>
              {typeof residual === "number"
                ? residual
                : t("common.notAvailable")}
            </Descriptions.Item>
            <Descriptions.Item label={t("alerts.center.evidence.sigma")}>
              {sigma}
            </Descriptions.Item>
            <Descriptions.Item label={t("alerts.center.evidence.ci")} span={2}>
              {typeof lower === "number" && typeof upper === "number"
                ? `[${lower}, ${upper}]`
                : t("common.notAvailable")}
            </Descriptions.Item>
          </Descriptions>
          {canRenderCiRange ? (
            <Card size="small" style={{ marginTop: 8 }}>
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Typography.Text type="secondary">
                  {t("alerts.center.evidence.ciVisualization")}
                </Typography.Text>
                <div style={{ position: "relative", height: 22 }}>
                  <div
                    style={{
                      position: "absolute",
                      top: 10,
                      left: 0,
                      width: "100%",
                      height: 3,
                      borderRadius: 999,
                      background: RANGE_INDICATOR_COLORS.track,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: 8,
                      left: `${toPercentPosition(lower)}%`,
                      width: `${Math.max(
                        2,
                        toPercentPosition(upper) - toPercentPosition(lower),
                      )}%`,
                      height: 7,
                      borderRadius: 999,
                      background: RANGE_INDICATOR_COLORS.range,
                    }}
                  />
                  <Tooltip
                    title={`${t("alerts.center.evidence.expected")}: ${expected}`}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: 2,
                        left: `${toPercentPosition(expected)}%`,
                        width: 2,
                        height: 18,
                        background: RANGE_INDICATOR_COLORS.expected,
                      }}
                    />
                  </Tooltip>
                  <Tooltip
                    title={`${t("alerts.center.evidence.observed")}: ${observed}`}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: `${toPercentPosition(observed)}%`,
                        width: 2,
                        height: 22,
                        background: RANGE_INDICATOR_COLORS.observed,
                      }}
                    />
                  </Tooltip>
                </div>
                <Space size={[8, 8]} wrap>
                  <Tag color="blue">{`CI [${lower.toFixed(3)}, ${upper.toFixed(3)}]`}</Tag>
                  <Tag>{`expected ${expected.toFixed(3)}`}</Tag>
                  <Tag color="red">{`observed ${observed.toFixed(3)}`}</Tag>
                </Space>
              </Space>
            </Card>
          ) : null}
        </>
      ) : fallback ? (
        <Alert
          type="warning"
          showIcon
          message={t("alerts.center.evidence.fallback")}
          description={safeJsonStringify(fallback)}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.empty")}
        </Typography.Text>
      )}
    </Space>
  );
}
