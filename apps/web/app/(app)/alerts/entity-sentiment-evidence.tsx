import {
  Card,
  Divider,
  Descriptions,
  List,
  Space,
  Tag,
  Typography,
} from "antd";
import type { EChartsOption } from "echarts";
import Link from "next/link";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { DashboardChart } from "@/components/echart";
import { formatDateTime } from "@/lib/i18n";

import {
  formatPercent,
  isRecord,
  toNumber,
  toStringValue,
  type LocaleCode,
  type TranslateFn,
} from "./evidence-utils";

/**
 * entity_sentiment 证据渲染（FE-批3 从 alert-center.tsx 原样迁出）。
 * 行为与视觉保持不变：窗口/基线负向占比对比图 + 证据条目列表。
 */
export function EntitySentimentEvidence({
  context,
  locale,
  t,
  colors,
  fontFamily,
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
  colors: {
    primary: string;
    accent: string;
  };
  fontFamily: string;
}) {
  const safeContext = context ?? null;
  const window = isRecord(safeContext?.window) ? safeContext.window : null;
  const baseline = isRecord(safeContext?.baseline)
    ? safeContext.baseline
    : null;
  const windowNegativeRatio = toNumber(window?.negativeRatio);
  const baselineNegativeRatio = toNumber(baseline?.negativeRatio);
  const ratioTrendOption: EChartsOption = (() => {
    const windowRatio =
      typeof windowNegativeRatio === "number"
        ? windowNegativeRatio * 100
        : null;
    const baselineRatio =
      typeof baselineNegativeRatio === "number"
        ? baselineNegativeRatio * 100
        : null;
    if (windowRatio === null && baselineRatio === null) {
      return {};
    }
    return {
      tooltip: {
        trigger: "axis",
        valueFormatter: (value) => `${Number(value).toFixed(1)}%`,
      },
      grid: { top: 24, left: 28, right: 20, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: [
          t("alerts.center.evidence.window"),
          t("alerts.center.evidence.baseline"),
        ],
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { formatter: "{value}%" },
      },
      series: [
        {
          type: "bar",
          data: [windowRatio ?? 0, baselineRatio ?? 0],
          itemStyle: {
            color: ({ dataIndex }: { dataIndex: number }) =>
              dataIndex === 0 ? colors.accent : colors.primary,
          },
          barMaxWidth: 42,
        },
      ],
      textStyle: { fontFamily },
    };
  })();

  if (!safeContext) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty")}
      </Typography.Text>
    );
  }

  const entityName = toStringValue(safeContext.entityName);
  const entityType = toStringValue(safeContext.entityType);
  const minEntityConfidence = toNumber(safeContext.minEntityConfidence);
  const z = toNumber(safeContext.z);

  const windowStart = toStringValue(window?.start);
  const windowEnd = toStringValue(window?.end);
  const baselineStart = toStringValue(baseline?.start);
  const baselineEnd = toStringValue(baseline?.end);

  const windowMinutes = toNumber(window?.minutes);
  const baselineMinutes = toNumber(baseline?.minutes);

  const windowTotal = toNumber(window?.total);
  const windowNegative = toNumber(window?.negative);
  const baselineTotal = toNumber(baseline?.total);
  const baselineNegative = toNumber(baseline?.negative);

  const evidenceItems = Array.isArray(safeContext.evidence)
    ? safeContext.evidence
    : [];

  const formatWindowLabel = (
    start: string | undefined,
    end: string | undefined,
  ): string => {
    if (!start || !end) return "";
    return `${formatDateTime(start, locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    })} → ${formatDateTime(end, locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    })}`;
  };

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {entityName ? <Tag>{entityName}</Tag> : null}
        {entityType ? <Tag color="blue">{entityType}</Tag> : null}
        {typeof z === "number" ? (
          <Tag color={z >= 3 ? "red" : z >= 2 ? "orange" : "green"}>{`z ${z.toFixed(3)}`}</Tag>
        ) : null}
        {typeof minEntityConfidence === "number" ? (
          <Tag>{`minConf ${minEntityConfidence.toFixed(2)}`}</Tag>
        ) : null}
      </Space>

      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label={t("alerts.center.evidence.window")}>
          <Space direction="vertical" size={0}>
            {windowMinutes ? (
              <Typography.Text type="secondary">{`${windowMinutes} min`}</Typography.Text>
            ) : null}
            {windowStart && windowEnd ? (
              <Typography.Text type="secondary">
                {formatWindowLabel(windowStart, windowEnd)}
              </Typography.Text>
            ) : null}
            <Typography.Text>
              {t("alerts.center.evidence.negRatio", {
                ratio:
                  formatPercent(windowNegativeRatio, 1) ||
                  t("common.notAvailable"),
                neg:
                  typeof windowNegative === "number"
                    ? windowNegative
                    : t("common.notAvailable"),
                total:
                  typeof windowTotal === "number"
                    ? windowTotal
                    : t("common.notAvailable"),
              })}
            </Typography.Text>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label={t("alerts.center.evidence.baseline")}>
          <Space direction="vertical" size={0}>
            {baselineMinutes ? (
              <Typography.Text type="secondary">{`${baselineMinutes} min`}</Typography.Text>
            ) : null}
            {baselineStart && baselineEnd ? (
              <Typography.Text type="secondary">
                {formatWindowLabel(baselineStart, baselineEnd)}
              </Typography.Text>
            ) : null}
            <Typography.Text>
              {t("alerts.center.evidence.negRatio", {
                ratio:
                  formatPercent(baselineNegativeRatio, 1) ||
                  t("common.notAvailable"),
                neg:
                  typeof baselineNegative === "number"
                    ? baselineNegative
                    : t("common.notAvailable"),
                total:
                  typeof baselineTotal === "number"
                    ? baselineTotal
                    : t("common.notAvailable"),
              })}
            </Typography.Text>
          </Space>
        </Descriptions.Item>
      </Descriptions>

      {Object.keys(ratioTrendOption).length > 0 ? (
        <Card size="small">
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.sentimentCompare")}
          </Typography.Text>
          <DashboardChart option={ratioTrendOption} height={200} />
        </Card>
      ) : null}

      {evidenceItems.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.evidenceItems")}
          </Typography.Text>
          <List
            size="small"
            dataSource={evidenceItems}
            renderItem={(item, index) => {
              const record = isRecord(item) ? item : null;
              const itemMetaId = toStringValue(record?.itemMetaId);
              const title =
                toStringValue(record?.title) ?? t("common.notAvailable");
              const source = toStringValue(record?.source);
              const summary = toStringValue(record?.summary);
              const publishedAt = toStringValue(record?.publishedAt);
              const ingestedAt =
                toStringValue(record?.ingestedAt) ??
                toStringValue(record?.createdAt);
              const ingestedLabel = t("items.time.ingested");
              const formatOptions = {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short",
              } as const;
              const ingestedText = ingestedAt
                ? formatDateTime(ingestedAt, locale, formatOptions)
                : t("common.notAvailable");

              return (
                <List.Item key={`${itemMetaId ?? "item"}-${index}`}>
                  <Space
                    direction="vertical"
                    size={0}
                    style={{ width: "100%" }}
                  >
                    <Typography.Text>
                      {itemMetaId ? (
                        <Link href={`/items/${itemMetaId}`}>{title}</Link>
                      ) : (
                        title
                      )}
                    </Typography.Text>
                    <Space size="small" wrap>
                      {source ? <Tag>{source}</Tag> : null}
                      <Space direction="vertical" size={0}>
                        <ArticlePublishedTime
                          publishedAt={publishedAt}
                          locale={locale}
                          formatOptions={formatOptions}
                          primaryStrong
                          secondaryStyle={{ fontSize: 12 }}
                        />
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {ingestedLabel}: {ingestedText}
                        </Typography.Text>
                      </Space>
                    </Space>
                    {summary ? (
                      <Typography.Text type="secondary">
                        {summary}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.noEvidenceItems")}
        </Typography.Text>
      )}
    </Space>
  );
}
