import {
  Descriptions,
  Divider,
  List,
  Space,
  Tag,
  Typography,
} from "antd";

import { formatDateTime } from "@/lib/i18n";

import {
  isRecord,
  toNumber,
  toStringValue,
  type LocaleCode,
  type TranslateFn,
} from "./evidence-utils";

/**
 * realtime_signal 证据渲染（FE-批3 从 alert-center.tsx 原样迁出）。
 * 行为与视觉保持不变：来源/新鲜度标签 + 结构化摘要 + tensions/leads/spikes。
 */
export function RealtimeSignalEvidence({
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

  const source =
    toStringValue(context.source) ??
    toStringValue(context.sourceName) ??
    toStringValue(context.sourceEndpoint) ??
    toStringValue(context.sourceFunction) ??
    toStringValue(context.sourceField);
  const stale = context.stale === true;
  const latestTimestamp = toStringValue(context.latestTimestamp);
  const maxStaleMinutes = toNumber(context.maxStaleMinutes);
  const snapshotFreshness = toStringValue(context.snapshotFreshness);
  const snapshotRetainedPrevious = context.snapshotRetainedPrevious === true;
  const snapshotFreshnessLabel = snapshotFreshness
    ? t(
        `alerts.center.evidence.realtime.snapshotFreshnessValues.${snapshotFreshness}`,
        {
          defaultValue: snapshotFreshness,
        },
      )
    : undefined;
  const countryCodes = Array.isArray(context.countryCodes)
    ? context.countryCodes
        .map((entry) => toStringValue(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  const summaryRows = [
    {
      key: "militaryCount",
      label: t("alerts.center.evidence.realtime.militaryCount"),
      value: toNumber(context.militaryCount),
    },
    {
      key: "currentValidPositionCount",
      label: t("alerts.center.evidence.realtime.currentValidPositionCount"),
      value: toNumber(context.currentValidPositionCount),
    },
    {
      key: "snapshotValidPositionCount",
      label: t("alerts.center.evidence.realtime.snapshotValidPositionCount"),
      value: toNumber(context.snapshotValidPositionCount),
    },
    {
      key: "droppedStalePositionCount",
      label: t("alerts.center.evidence.realtime.droppedStalePositionCount"),
      value: toNumber(context.droppedStalePositionCount),
    },
    {
      key: "disruptions",
      label: t("alerts.center.evidence.realtime.disruptions"),
      value: toNumber(context.disruptions),
    },
    {
      key: "outages",
      label: t("alerts.center.evidence.realtime.outages"),
      value: toNumber(context.outages),
    },
    {
      key: "unrestCount",
      label: t("alerts.center.evidence.realtime.unrest"),
      value: toNumber(context.unrestCount),
    },
    {
      key: "acledCount",
      label: t("alerts.center.evidence.realtime.acled"),
      value: toNumber(context.acledCount),
    },
    {
      key: "gdeltCount",
      label: t("alerts.center.evidence.realtime.gdelt"),
      value: toNumber(context.gdeltCount),
    },
    {
      key: "dedupeReducedBy",
      label: t("alerts.center.evidence.realtime.dedupeReducedBy"),
      value: toNumber(context.dedupeReducedBy),
    },
    {
      key: "defcon",
      label: t("alerts.center.evidence.realtime.defcon"),
      value: toNumber(context.defcon),
    },
    {
      key: "adjustedScore",
      label: t("alerts.center.evidence.realtime.adjustedScore"),
      value: toNumber(context.adjustedScore),
    },
    {
      key: "openLocations",
      label: t("alerts.center.evidence.realtime.openLocations"),
      value: toNumber(context.openLocations),
    },
    {
      key: "activeSpikes",
      label: t("alerts.center.evidence.realtime.activeSpikes"),
      value: toNumber(context.activeSpikes),
    },
    {
      key: "avgPop",
      label: t("alerts.center.evidence.realtime.avgPop"),
      value: toNumber(context.avgPop),
    },
  ].filter((entry) => typeof entry.value === "number");

  const tensions = Array.isArray(context.tensions)
    ? context.tensions
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 5)
    : [];
  const leads = Array.isArray(context.leads)
    ? context.leads
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 5)
    : [];
  const spikes = Array.isArray(context.spikes)
    ? context.spikes
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 5)
    : [];
  const hasStructuredEvidence =
    summaryRows.length > 0 ||
    countryCodes.length > 0 ||
    tensions.length > 0 ||
    leads.length > 0 ||
    spikes.length > 0;

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {source ? (
          <Tag color="blue">
            {t("alerts.center.evidence.realtime.source")}
            : {source}
          </Tag>
        ) : null}
        {stale ? (
          <Tag color="red">
            {t("alerts.center.evidence.realtime.stale")}
          </Tag>
        ) : null}
        {snapshotFreshness ? (
          <Tag
            color={
              snapshotFreshness === "fresh"
                ? "green"
                : snapshotFreshness === "stale"
                  ? "orange"
                  : "default"
            }
          >
            {t("alerts.center.evidence.realtime.snapshotFreshness")}
            : {snapshotFreshnessLabel}
          </Tag>
        ) : null}
        {snapshotRetainedPrevious ? (
          <Tag color="gold">
            {t("alerts.center.evidence.realtime.snapshotRetainedPrevious")}
          </Tag>
        ) : null}
        {typeof maxStaleMinutes === "number" ? (
          <Tag>
            {t("alerts.center.evidence.realtime.maxStaleMinutes", {
              minutes: maxStaleMinutes,
            })}
          </Tag>
        ) : null}
      </Space>

      {latestTimestamp ? (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.realtime.latestTimestamp", {
            time: formatDateTime(latestTimestamp, locale, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short",
            }),
          })}
        </Typography.Text>
      ) : null}

      {!hasStructuredEvidence ? (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.realtime.emptyStructured")}
        </Typography.Text>
      ) : null}

      {summaryRows.length > 0 ? (
        <Descriptions size="small" bordered column={2}>
          {summaryRows.map((entry) => (
            <Descriptions.Item key={entry.key} label={entry.label}>
              {entry.value}
            </Descriptions.Item>
          ))}
        </Descriptions>
      ) : null}

      {countryCodes.length > 0 ? (
        <div>
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.countryCodes")}
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Space size={[6, 6]} wrap>
              {countryCodes.map((code) => (
                <Tag key={code}>{code}</Tag>
              ))}
            </Space>
          </div>
        </div>
      ) : null}

      {tensions.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.tensions")}
          </Typography.Text>
          <List
            size="small"
            dataSource={tensions}
            renderItem={(item, index) => {
              const label =
                toStringValue(item.label) ??
                toStringValue(item.id) ??
                `tension-${index + 1}`;
              const score = toNumber(item.score);
              const changePercent = toNumber(item.changePercent);
              const trend = toStringValue(item.trend);
              return (
                <List.Item key={`${label}-${index}`}>
                  <Space size={[8, 8]} wrap>
                    <Typography.Text>{label}</Typography.Text>
                    {typeof score === "number" ? (
                      <Tag color="orange">{`score ${score.toFixed(2)}`}</Tag>
                    ) : null}
                    {typeof changePercent === "number" ? (
                      <Tag>{`${changePercent.toFixed(2)}%`}</Tag>
                    ) : null}
                    {trend ? <Tag color="blue">{trend}</Tag> : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}

      {leads.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.leads")}
          </Typography.Text>
          <List
            size="small"
            dataSource={leads}
            renderItem={(item, index) => {
              const title =
                toStringValue(item.title) ??
                toStringValue(item.id) ??
                `lead-${index + 1}`;
              const shift = toNumber(item.shift);
              const confidence = toNumber(item.confidence);
              return (
                <List.Item key={`${title}-${index}`}>
                  <Space size={[8, 8]} wrap>
                    <Typography.Text>{title}</Typography.Text>
                    {typeof shift === "number" ? (
                      <Tag color="purple">{`shift ${shift.toFixed(2)}`}</Tag>
                    ) : null}
                    {typeof confidence === "number" ? (
                      <Tag>{`conf ${confidence.toFixed(2)}`}</Tag>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}

      {spikes.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.spikes")}
          </Typography.Text>
          <List
            size="small"
            dataSource={spikes}
            renderItem={(item, index) => {
              const term =
                toStringValue(item.term) ??
                toStringValue(item.id) ??
                `spike-${index + 1}`;
              const count = toNumber(item.count);
              const multiplier = toNumber(item.multiplier);
              return (
                <List.Item key={`${term}-${index}`}>
                  <Space size={[8, 8]} wrap>
                    <Typography.Text>{term}</Typography.Text>
                    {typeof count === "number" ? (
                      <Tag>{`count ${count}`}</Tag>
                    ) : null}
                    {typeof multiplier === "number" ? (
                      <Tag color="gold">{`${multiplier.toFixed(2)}x`}</Tag>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}
    </Space>
  );
}
