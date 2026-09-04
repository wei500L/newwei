"use client";

import { List, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { formatDateTime, type resolveLocale } from "@/lib/i18n";

import type { AlertEventItem } from "./alert-center-list-model";

/**
 * Alert Center 详情 Deliveries 页签（FE-批3B 从 alert-center.tsx 提取）。
 * 投递记录列表：状态 Tag（配色）/渠道/名称/目标/发送时间/错误。
 */

const deliveryStatusColor: Record<string, string> = {
  pending: "orange",
  sending: "blue",
  sent: "green",
  failed: "red",
};

export interface AlertEventDeliveriesTabProps {
  selectedEvent: AlertEventItem;
  locale: ReturnType<typeof resolveLocale>;
}

export function AlertEventDeliveriesTab({
  selectedEvent,
  locale,
}: AlertEventDeliveriesTabProps) {
  const { t } = useTranslation();

  return (
    <List
      size="small"
      dataSource={selectedEvent.deliveries}
      locale={{
        emptyText: t("alerts.center.deliveriesEmpty"),
      }}
      renderItem={(delivery) => (
        <List.Item>
          <Space size="small" wrap>
            <Tag color={deliveryStatusColor[delivery.status] ?? "default"}>
              {delivery.status}
            </Tag>
            <Tag>{delivery.channelType}</Tag>
            {delivery.channelName ? (
              <Typography.Text>{delivery.channelName}</Typography.Text>
            ) : null}
            {!delivery.channelName && delivery.target ? (
              <Typography.Text>{delivery.target}</Typography.Text>
            ) : null}
            {delivery.channelName && delivery.target ? (
              <Typography.Text type="secondary">
                {delivery.target}
              </Typography.Text>
            ) : null}
            <Typography.Text type="secondary">
              {delivery.sentAt
                ? formatDateTime(delivery.sentAt, locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZoneName: "short",
                  })
                : t("common.notAvailable")}
            </Typography.Text>
            {delivery.error ? (
              <Typography.Text type="secondary">
                {delivery.error}
              </Typography.Text>
            ) : null}
          </Space>
        </List.Item>
      )}
    />
  );
}
