"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Divider, List, Popover, Select, Space, Tag, Grid, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

import type { SituationMonitorMatchResult } from "../types/situation-monitor-monitors";
import type {
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationTelegramFeedResponse,
} from "../types/situation-monitor-signals";
import {
  isRecentOrefTimestamp,
  parseOrefTimestamp,
  translateOrefTextForLocale,
} from "../utils/oref-display";

import { useSituationMonitorHeadlines } from "./situation-monitor-headlines";

export interface SituationMonitorTelegramFeedPanelProps {
  telegramFeed: SituationTelegramFeedResponse | null;
  signalsLoadingTelegram: boolean;
  signalErrorTelegram: string | null;
  telegramTopicFilter: string;
  telegramChannelFilter: string;
  telegramTopicOptions: { label: string; value: string }[];
  telegramChannelOptions: { label: string; value: string }[];
  setTelegramTopicFilter: (value: string) => void;
  setTelegramChannelFilter: (value: string) => void;
  hasAccessToken: boolean;
  canReadItems: boolean;
  canManageSettings: boolean;
  monitoringSettingsHref: string;
  locale: SupportedLocale;
  translateToZh: boolean;
  monitorMatchesByKey: Map<string, SituationMonitorMatchResult[]>;
  monitorColorById: Map<string, string>;
}

export function SituationMonitorTelegramFeedPanel(
  props: SituationMonitorTelegramFeedPanelProps,
) {
  const {
    telegramFeed,
    signalsLoadingTelegram,
    signalErrorTelegram,
    telegramTopicFilter,
    telegramChannelFilter,
    telegramTopicOptions,
    telegramChannelOptions,
    setTelegramTopicFilter,
    setTelegramChannelFilter,
    hasAccessToken,
    canReadItems,
    canManageSettings,
    monitoringSettingsHref,
    locale,
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  } = props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const telegramItemsPerPanel = screens.lg ? 14 : 10;
  const globalTelegramTooltip = t("situationMonitor.shared.telegramTooltip");
  const { renderMonitorMatches } = useSituationMonitorHeadlines({
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  });
  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.telegram.title")}
          </span>
          <Popover content={globalTelegramTooltip}>
            <Tag color="default" className="cursor-help">
              {t("situationMonitor.shared.label")}{" "}
              <InfoCircleOutlined />
            </Tag>
          </Popover>
          <Tag color="geekblue">
            {telegramFeed?.count ?? telegramFeed?.items?.length ?? 0}
          </Tag>
          {telegramFeed?.channelSet ? (
            <Tag color="cyan">{telegramFeed.channelSet}</Tag>
          ) : null}
          {telegramFeed && !telegramFeed.configured ? (
            <Tag color="default">
              {t("situationMonitor.telegram.configMissing")}
            </Tag>
          ) : null}
          {telegramFeed && !telegramFeed.enabled ? (
            <Tag color="orange">
              {t("situationMonitor.telegram.disabled")}
            </Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={signalsLoadingTelegram && !telegramFeed}
    >
      {telegramFeed?.error ? (
        <Alert type="warning" showIcon message={telegramFeed.error} />
      ) : null}
      {signalErrorTelegram ? (
        <Alert
          type="warning"
          showIcon
          message={signalErrorTelegram}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Space wrap size={8} style={{ marginBottom: 10 }}>
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.filters.label")}
        </Typography.Text>
        <Select
          size="small"
          style={{ minWidth: 150 }}
          value={telegramTopicFilter}
          options={telegramTopicOptions}
          onChange={(value) => setTelegramTopicFilter(String(value))}
        />
        <Select
          size="small"
          style={{ minWidth: 180 }}
          value={telegramChannelFilter}
          options={telegramChannelOptions}
          showSearch
          optionFilterProp="label"
          onChange={(value) => setTelegramChannelFilter(String(value))}
        />
      </Space>
      {!hasAccessToken ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.signInRequired")}
        </Typography.Text>
      ) : !canReadItems ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.permissionRequired")}
        </Typography.Text>
      ) : !telegramFeed ? (
        <Typography.Text type="secondary">
          {t("common.loading")}
        </Typography.Text>
      ) : !telegramFeed.configured ? (
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            {t("situationMonitor.telegram.configHint")}
          </Typography.Text>
          {canManageSettings ? (
            <Button size="small" href={monitoringSettingsHref}>
              {t("situationMonitor.actions.openSettings")}
            </Button>
          ) : null}
        </Space>
      ) : telegramFeed.items.length === 0 ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.telegram.empty")}
        </Typography.Text>
      ) : (
        <List
          size="small"
          dataSource={telegramFeed.items.slice(0, telegramItemsPerPanel)}
          renderItem={(item) => {
            const href = item.url ? safeHttpUrl(item.url) : null;
            const date = item.ts ? new Date(item.ts) : null;
            const text = typeof item.text === "string" ? item.text.trim() : "";
            return (
              <List.Item key={item.id}>
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Space size={8} wrap>
                    <Tag color="blue">{item.channelTitle || item.channel}</Tag>
                    {item.topic ? (
                      <Tag color="default">{item.topic}</Tag>
                    ) : null}
                    {renderMonitorMatches(
                      [`telegram:${item.id}`],
                      `telegram:${item.id}`,
                    )}
                  </Space>
                  {href ? (
                    <Typography.Link
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {text}
                    </Typography.Link>
                  ) : (
                    <Typography.Text>{text}</Typography.Text>
                  )}
                  <Space size={8} wrap>
                    {date && !Number.isNaN(date.getTime()) ? (
                      <Typography.Text type="secondary">
                        {formatDateTime(date, locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Typography.Text>
                    ) : null}
                    {Array.isArray(item.tags)
                      ? item.tags.slice(0, 2).map((tag) => (
                          <Tag key={`${item.id}:${tag}`} color="default">
                            {tag}
                          </Tag>
                        ))
                      : null}
                  </Space>
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
}

export interface SituationMonitorOrefAlertsPanelProps {
  orefAlerts: SituationOrefAlertsResponse | null;
  orefHistory: SituationOrefHistoryResponse | null;
  signalsLoadingOref: boolean;
  signalErrorOref: string | null;
  hasAccessToken: boolean;
  canReadItems: boolean;
  canManageSettings: boolean;
  monitoringSettingsHref: string;
  locale: SupportedLocale;
  translateToZh: boolean;
  monitorMatchesByKey: Map<string, SituationMonitorMatchResult[]>;
  monitorColorById: Map<string, string>;
}

export function SituationMonitorOrefAlertsPanel(
  props: SituationMonitorOrefAlertsPanelProps,
) {
  const {
    orefAlerts,
    orefHistory,
    signalsLoadingOref,
    signalErrorOref,
    hasAccessToken,
    canReadItems,
    canManageSettings,
    monitoringSettingsHref,
    locale,
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  } = props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const orefAlertsPerPanel = screens.lg ? 12 : 8;
  const orefHistoryPerPanel = screens.lg ? 6 : 4;
  const globalOrefTooltip = t("situationMonitor.shared.orefTooltip");
  const { renderMonitorMatches } = useSituationMonitorHeadlines({
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  });
  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.oref.title")}
          </span>
          <Popover content={globalOrefTooltip}>
            <Tag color="default" className="cursor-help">
              {t("situationMonitor.shared.label")}{" "}
              <InfoCircleOutlined />
            </Tag>
          </Popover>
          <Tag color="geekblue">{orefAlerts?.alerts?.length ?? 0}</Tag>
          <Tag color="purple">
            {t("situationMonitor.oref.history24h", {
              count:
                orefAlerts?.historyCount24h ??
                orefHistory?.historyCount24h ??
                0,
            })}
          </Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={signalsLoadingOref && !orefAlerts}
    >
      {orefAlerts?.error ? (
        <Alert type="warning" showIcon message={orefAlerts.error} />
      ) : null}
      {signalErrorOref ? (
        <Alert
          type="warning"
          showIcon
          message={signalErrorOref}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {!hasAccessToken ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.oref.signInRequired")}
        </Typography.Text>
      ) : !canReadItems ? (
        <Typography.Text type="secondary">
          {t("situationMonitor.oref.permissionRequired")}
        </Typography.Text>
      ) : !orefAlerts ? (
        <Typography.Text type="secondary">
          {t("common.loading")}
        </Typography.Text>
      ) : !orefAlerts.configured ? (
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            {t("situationMonitor.oref.configHint")}
          </Typography.Text>
          {canManageSettings ? (
            <Button size="small" href={monitoringSettingsHref}>
              {t("situationMonitor.actions.openSettings")}
            </Button>
          ) : null}
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {orefAlerts.alerts.length === 0 ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.oref.empty")}
            </Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={orefAlerts.alerts.slice(0, orefAlertsPerPanel)}
              renderItem={(alert) => {
                const alertDate = parseOrefTimestamp(alert.alertDate);
                const alertDateText =
                  alertDate && !Number.isNaN(alertDate.getTime())
                    ? formatDateTime(alertDate, locale, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : alert.alertDate;
                const recent = isRecentOrefTimestamp(alert.alertDate);

                return (
                  <List.Item key={alert.id}>
                    <Space
                      direction="vertical"
                      size={2}
                      style={{ width: "100%" }}
                    >
                      <Space size={8} wrap>
                        <Tag color="red">
                          {translateOrefTextForLocale(alert.cat || "alert", {
                            translateToZh,
                          })}
                        </Tag>
                        <Typography.Text>
                          {translateOrefTextForLocale(alert.title, {
                            translateToZh,
                          })}
                        </Typography.Text>
                        {recent ? (
                          <Tag color="volcano">
                            {t("situationMonitor.oref.recent")}
                          </Tag>
                        ) : null}
                      </Space>
                      {Array.isArray(alert.data) && alert.data.length > 0 ? (
                        <Typography.Text type="secondary">
                          {alert.data
                            .slice(0, 4)
                            .map((area) =>
                              translateOrefTextForLocale(area, {
                                translateToZh,
                              }),
                            )
                            .join(" · ")}
                        </Typography.Text>
                      ) : null}
                      {renderMonitorMatches(
                        [`oref:${alert.id}`],
                        `oref-alert:${alert.id}`,
                      )}
                      {alertDateText ? (
                        <Typography.Text type="secondary">
                          {alertDateText}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  </List.Item>
                );
              }}
            />
          )}

          {orefHistory?.history?.length ? (
            <>
              <Divider style={{ margin: "8px 0" }} />
              <Typography.Text type="secondary">
                {t("situationMonitor.oref.recentWaves")}
              </Typography.Text>
              <List
                size="small"
                dataSource={[...orefHistory.history]
                  .reverse()
                  .slice(0, orefHistoryPerPanel)}
                renderItem={(entry) => {
                  const date = parseOrefTimestamp(entry.timestamp);
                  const waveCount = (entry.alerts ?? []).reduce((sum, item) => {
                    const count =
                      Array.isArray(item.data) && item.data.length > 0
                        ? item.data.length
                        : 1;
                    return sum + count;
                  }, 0);
                  const recent = isRecentOrefTimestamp(entry.timestamp);
                  return (
                    <List.Item key={entry.timestamp}>
                      <Space
                        direction="vertical"
                        size={6}
                        style={{ width: "100%" }}
                      >
                        <Space size={8} wrap>
                          <Tag color="default">{waveCount}</Tag>
                          {recent ? (
                            <Tag color="volcano">
                              {t("situationMonitor.oref.recent")}
                            </Tag>
                          ) : null}
                          {date && !Number.isNaN(date.getTime()) ? (
                            <Typography.Text type="secondary">
                              {formatDateTime(date, locale, {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </Typography.Text>
                          ) : (
                            <Typography.Text type="secondary">
                              {entry.timestamp}
                            </Typography.Text>
                          )}
                        </Space>
                        {renderMonitorMatches(
                          (entry.alerts ?? []).map(
                            (alert) =>
                              `oref-history:${entry.timestamp}:${alert.id}`,
                          ),
                          `oref-history:${entry.timestamp}`,
                        )}
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </>
          ) : null}
        </Space>
      )}
    </Card>
  );
}
