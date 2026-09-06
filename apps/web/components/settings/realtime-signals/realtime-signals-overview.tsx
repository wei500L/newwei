"use client";

import { Card, Col, Divider, Row, Space, Statistic, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type {
  RealtimeSignalSourceStatusRow,
  RealtimeSignalsSecretSource,
  RealtimeSignalsSecretStatusRow,
  RealtimeSignalsSettingsResponse,
} from "./realtime-signals-types";

export interface RealtimeSignalsOverviewProps {
  settings: RealtimeSignalsSettingsResponse;
  sourceStatusRows: RealtimeSignalSourceStatusRow[];
  secretStatusRows: RealtimeSignalsSecretStatusRow[];
  formatTimestamp: (value?: string) => string;
}

export function RealtimeSignalsOverview({
  settings,
  sourceStatusRows,
  secretStatusRows,
  formatTimestamp,
}: RealtimeSignalsOverviewProps) {
  const { t } = useTranslation();

  const sourceTagColor = settings.source === "db" ? "green" : "default";
  const sourceTagLabel =
    settings.source === "db"
      ? t("systemSettings.realtimeSignals.status.saved")
      : t("systemSettings.realtimeSignals.status.env");
  const acledApiDisabled = !settings.acledApiEnabled;
  const acledApiStatusLabel = settings.acledApiEnabled
    ? t("systemSettings.realtimeSignals.status.acledApiEnabled")
    : t("systemSettings.realtimeSignals.status.acledApiDisabled");
  const enabledTagColor = settings.enabled ? "green" : "default";
  const enabledTagLabel = settings.enabled
    ? t("systemSettings.realtimeSignals.status.enabled")
    : t("systemSettings.realtimeSignals.status.disabled");
  const secretSourceLabel = (value: RealtimeSignalsSecretSource) =>
    t(`systemSettings.realtimeSignals.status.secretSources.${value}`, {
      defaultValue: value,
    });
  const acledTokenStatusLabel = t(
    `systemSettings.realtimeSignals.status.acledTokenStatuses.${settings.acledAccessTokenStatus}`,
    {
      defaultValue: settings.acledAccessTokenStatus,
    },
  );
  const acledTokenStatusColor =
    settings.acledAccessTokenStatus === "ready"
      ? "green"
      : settings.acledAccessTokenStatus === "expiring"
        ? "gold"
        : settings.acledAccessTokenStatus === "refresh_failed"
          ? "red"
          : "default";

  const enabledSourceCount = sourceStatusRows.filter(
    (row) => row.enabled,
  ).length;
  const disabledSourceCount = sourceStatusRows.length - enabledSourceCount;
  const fastestEnabledInterval = sourceStatusRows
    .filter((row) => row.enabled && typeof row.intervalSec === "number")
    .reduce<number | null>(
      (acc, row) =>
        acc === null || (row.intervalSec as number) < acc
          ? (row.intervalSec as number)
          : acc,
      null,
    );
  const configuredSecretCount = secretStatusRows.filter((row) => row.has)
    .length;

  return (
    <>
      <Row gutter={[12, 12]} style={{ marginBottom: "1rem" }}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.enabledSources",
              )}
              value={enabledSourceCount}
              suffix={`/ ${sourceStatusRows.length}`}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.disabledSources",
              )}
              value={disabledSourceCount}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.fastestInterval",
              )}
              value={fastestEnabledInterval ?? "—"}
              suffix={fastestEnabledInterval ? "sec" : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.configuredSecrets",
              )}
              value={configuredSecretCount}
              suffix={`/ ${secretStatusRows.length}`}
            />
          </Card>
        </Col>
      </Row>

      <Space
        direction="vertical"
        size="small"
        style={{ display: "flex", marginBottom: "1rem" }}
      >
        <Space wrap>
          <Typography.Text>
            {t("systemSettings.realtimeSignals.status.label")}
          </Typography.Text>
          <Tag color={sourceTagColor}>{sourceTagLabel}</Tag>
          <Tag color={enabledTagColor}>{enabledTagLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.openskyBaseUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.openskyBaseUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.openskyTokenUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.openskyTokenUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.aisRelayBaseUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.aisRelayBaseUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.openskyClientId")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.openskyClientId ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Tag color={settings.openskyClientId ? "blue" : "default"}>
            {secretSourceLabel(settings.openskyClientIdSource)}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.polymarketProxyUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.polymarketProxyUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.acledApi")}
          </Typography.Text>
          <Tag color={settings.acledApiEnabled ? "green" : "gold"}>
            {acledApiStatusLabel}
          </Tag>
          {acledApiDisabled ? (
            <Typography.Text type="secondary">
              {t("systemSettings.realtimeSignals.alerts.acledDisabled.inline")}
            </Typography.Text>
          ) : null}
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.acledOauthUsername")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.acledOauthUsername ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Tag color={settings.acledOauthUsername ? "blue" : "default"}>
            {secretSourceLabel(settings.acledOauthUsernameSource)}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.acledOauthClientId")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.acledOauthClientId || "acled"}
          </Tag>
          <Tag
            color={
              settings.acledOauthClientIdSource === "none"
                ? "default"
                : "blue"
            }
          >
            {secretSourceLabel(settings.acledOauthClientIdSource)}
          </Tag>
        </Space>
        {settings.acledApiEnabled ? (
          <>
            <Space wrap>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessToken",
                )}
              </Typography.Text>
              <Tag color={acledTokenStatusColor}>{acledTokenStatusLabel}</Tag>
              <Tag color={settings.hasAcledAccessToken ? "blue" : "default"}>
                {secretSourceLabel(settings.acledAccessTokenSource)}
              </Tag>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenExpiresAt",
                )}
              </Typography.Text>
              <Tag color="geekblue">
                {formatTimestamp(settings.acledAccessTokenExpiresAt)}
              </Tag>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenRefreshedAt",
                )}
              </Typography.Text>
              <Tag color="geekblue">
                {formatTimestamp(settings.acledAccessTokenRefreshedAt)}
              </Tag>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenLastAttemptAt",
                )}
              </Typography.Text>
              <Tag color="geekblue">
                {formatTimestamp(settings.acledAccessTokenLastAttemptAt)}
              </Tag>
            </Space>
            {settings.acledAccessTokenLastError ? (
              <Typography.Text type="danger">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenLastError",
                )}
                {`: ${settings.acledAccessTokenLastError}`}
              </Typography.Text>
            ) : null}
          </>
        ) : null}
        {secretStatusRows.map((row) => (
          <Space key={row.key} wrap>
            <Typography.Text type="secondary">{row.label}</Typography.Text>
            <Tag color={row.has ? "blue" : "default"}>
              {secretSourceLabel(row.source)}
            </Tag>
          </Space>
        ))}

        <Divider style={{ margin: "8px 0" }} />

        <Typography.Text type="secondary">
          {t("systemSettings.realtimeSignals.status.sourceSnapshot")}
        </Typography.Text>
        <Space wrap size={[8, 8]}>
          {sourceStatusRows.map((row) => (
            <Tag key={row.key} color={row.enabled ? "green" : "default"}>
              {row.sourceName} ·{" "}
              {row.enabled
                ? t("systemSettings.realtimeSignals.status.enabled")
                : t("systemSettings.realtimeSignals.status.disabled")}
              {row.intervalLabel ? ` · ${row.intervalLabel}` : ""}
            </Tag>
          ))}
        </Space>
      </Space>
    </>
  );
}
