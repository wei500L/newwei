import {
  Button,
  Descriptions,
  Divider,
  List,
  Progress,
  Space,
  Tag,
  Typography,
} from "antd";

import { formatDateTime } from "@/lib/i18n";

import {
  formatFixed,
  isRecord,
  toNumber,
  toStringValue,
  type LocaleCode,
  type TranslateFn,
} from "./evidence-utils";

/**
 * entity_association 证据渲染（FE-批3 从 alert-center.tsx 原样迁出）。
 * 行为与视觉保持不变：种子实体 + 源事件 + 关联目标列表（含跳转源事件）。
 */
export function EntityAssociationEvidence({
  context,
  locale,
  t,
  onOpenEvent,
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
  onOpenEvent: (eventId: string) => void;
}) {
  if (!context) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty")}
      </Typography.Text>
    );
  }

  const seed = isRecord(context.seed) ? context.seed : null;
  const seedName = toStringValue(seed?.name);
  const seedType = toStringValue(seed?.type);

  const sourceEvent = isRecord(context.sourceEvent)
    ? context.sourceEvent
    : null;
  const sourceEventId = toStringValue(sourceEvent?.id);
  const sourceEventTriggeredAt = toStringValue(sourceEvent?.triggeredAt);
  const sourceEventMetricValue = toNumber(sourceEvent?.metricValue);
  const sourceEventStatus = toStringValue(sourceEvent?.status);
  const sourceTriggeredLabel = sourceEventTriggeredAt
    ? formatDateTime(sourceEventTriggeredAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "";

  const targets = Array.isArray(context.targets) ? context.targets : [];

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {seedName ? <Tag>{seedName}</Tag> : null}
        {seedType ? <Tag color="blue">{seedType}</Tag> : null}
      </Space>

      {sourceEventId ? (
        <Descriptions size="small" bordered column={1}>
          <Descriptions.Item label={t("alerts.center.evidence.sourceEvent")}>
            <Space direction="vertical" size={2}>
              <Space size="small" wrap>
                <Tag>{sourceEventId}</Tag>
                {sourceEventStatus ? <Tag>{sourceEventStatus}</Tag> : null}
                {typeof sourceEventMetricValue === "number" ? (
                  <Tag>{`metric ${sourceEventMetricValue}`}</Tag>
                ) : null}
              </Space>
              {sourceTriggeredLabel ? (
                <Typography.Text type="secondary">
                  {sourceTriggeredLabel}
                </Typography.Text>
              ) : null}
              <Button size="small" onClick={() => onOpenEvent(sourceEventId)}>
                {t("alerts.center.evidence.openSourceEvent")}
              </Button>
            </Space>
          </Descriptions.Item>
        </Descriptions>
      ) : (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.sourceEventMissing")}
        </Typography.Text>
      )}

      <Divider style={{ margin: "8px 0" }} />
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.targets")}
      </Typography.Text>
      <List
        size="small"
        dataSource={targets}
        locale={{
          emptyText: t("alerts.center.evidence.targetsEmpty"),
        }}
        renderItem={(item, index) => {
          const record = isRecord(item) ? item : null;
          const name = toStringValue(record?.name) ?? t("common.notAvailable");
          const type = toStringValue(record?.type);
          const relationType = toStringValue(record?.relationType);
          const score = toNumber(record?.score);
          const weight = toNumber(record?.weight);
          const confidence = toNumber(record?.confidence);
          return (
            <List.Item
              key={`${toStringValue(record?.entityId) ?? "entity"}-${index}`}
            >
              <Space direction="vertical" size={0} style={{ width: "100%" }}>
                <Space size="small" wrap>
                  <Typography.Text>{name}</Typography.Text>
                  {type ? <Tag color="blue">{type}</Tag> : null}
                  {relationType ? <Tag>{relationType}</Tag> : null}
                  {typeof score === "number" ? (
                    <Tag color="orange">{`score ${score.toFixed(3)}`}</Tag>
                  ) : null}
                </Space>
                <Typography.Text type="secondary">
                  {t("alerts.center.evidence.targetMeta", {
                    weight: formatFixed(weight, 3) || t("common.notAvailable"),
                    conf:
                      formatFixed(confidence, 3) || t("common.notAvailable"),
                  })}
                </Typography.Text>
                {(typeof score === "number" ||
                  typeof confidence === "number") && (
                  <Progress
                    percent={Math.max(
                      0,
                      Math.min(
                        100,
                        Math.round(((score ?? confidence ?? 0) * 100) / 1),
                      ),
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor="#f97316"
                  />
                )}
              </Space>
            </List.Item>
          );
        }}
      />
    </Space>
  );
}
