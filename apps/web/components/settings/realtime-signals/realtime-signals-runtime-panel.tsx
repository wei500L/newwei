"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";

import { RealtimeSignalsMarkerReadiness, RealtimeSignalsInsights } from "./realtime-signals-marker-readiness";
import { RealtimeSignalsOpenskyBudgetPanel } from "./realtime-signals-opensky-budget";
import { runtimeStatusColor, runtimeStatusLabel } from "./realtime-signals-runtime-model";
import { RealtimeSignalsSourceCard } from "./realtime-signals-source-card";
import type {
  RealtimeSignalSourceKey,
  RealtimeSignalsSettingsResponse,
  RealtimeSignalsRuntimeDiagnosticsResponse,
} from "./realtime-signals-types";

export interface RealtimeSignalsRuntimePanelProps {
  diagnostics: RealtimeSignalsRuntimeDiagnosticsResponse | null;
  loading: boolean;
  error: string | null;
  settings: RealtimeSignalsSettingsResponse;
  sourceNameByKey: Record<RealtimeSignalSourceKey, string>;
  formatTimestamp: (value?: string) => string;
  onRefresh: () => void;
}

export function RealtimeSignalsRuntimePanel({
  diagnostics,
  loading,
  error,
  settings,
  sourceNameByKey,
  formatTimestamp,
  onRefresh,
}: RealtimeSignalsRuntimePanelProps) {
  const { t } = useTranslation();

  const acledApiDisabled = !settings.acledApiEnabled;
  const runtimeSettingsSource = diagnostics?.settingsSource ?? "unknown";
  const runtimeSettingsSourceColor =
    runtimeSettingsSource === "db"
      ? "green"
      : runtimeSettingsSource === "unknown"
        ? "gold"
        : "default";
  const runtimeSettingsSourceLabel = t(
    `systemSettings.realtimeSignals.runtime.settingsSources.${runtimeSettingsSource}`,
    {
      defaultValue:
        runtimeSettingsSource === "db"
          ? "Saved override"
          : runtimeSettingsSource === "env"
            ? "Using env defaults"
            : "Source unavailable",
    },
  );
  const runtimeIssues =
    diagnostics?.sources.filter(
      (row) => row.status === "error" || row.status === "stale",
    ) ?? [];
  const runtimeWarnings =
    diagnostics?.sources.filter((row) => row.status === "not_configured") ??
    [];

  return (
    <Card
      size="small"
      title={t("systemSettings.realtimeSignals.runtime.title")}
      extra={
        <Space wrap>
          {diagnostics ? (
            <Tag color={runtimeSettingsSourceColor}>
              {t("systemSettings.realtimeSignals.runtime.settingsSource")}
              : {runtimeSettingsSourceLabel}
            </Tag>
          ) : null}
          {diagnostics?.checkedAt ? (
            <Typography.Text type="secondary">
              {t("systemSettings.realtimeSignals.runtime.checkedAt", {
                time: formatTimestamp(diagnostics.checkedAt),
              })}
            </Typography.Text>
          ) : null}
          <Button onClick={onRefresh} loading={loading}>
            {t("common.refresh")}
          </Button>
        </Space>
      }
      style={{ marginBottom: "1rem" }}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button size="small" onClick={onRefresh} loading={loading}>
              {t("common.retry")}
            </Button>
          }
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {diagnostics?.settingsSource === "unknown" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t(
            "systemSettings.realtimeSignals.runtime.settingsSourceUnknown.title",
          )}
          description={t(
            "systemSettings.realtimeSignals.runtime.settingsSourceUnknown.body",
          )}
        />
      ) : null}

      {runtimeIssues.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t("systemSettings.realtimeSignals.runtime.issues", {
            count: runtimeIssues.length,
          })}
          description={
            <Space wrap size={[8, 8]}>
              {runtimeIssues.map((row) => (
                <Tag
                  key={`${row.source}-issue`}
                  color={runtimeStatusColor(row.status)}
                >
                  {sourceNameByKey[row.source]} ·{" "}
                  {runtimeStatusLabel(t, row.status)}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      {!error && runtimeWarnings.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t("systemSettings.realtimeSignals.runtime.warnings")}
          description={
            <Space wrap size={[8, 8]}>
              {runtimeWarnings.map((row) => (
                <Tag
                  key={`${row.source}-warning`}
                  color={runtimeStatusColor(row.status)}
                >
                  {sourceNameByKey[row.source]} ·{" "}
                  {runtimeStatusLabel(t, row.status)}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      {diagnostics ? (
        <Space direction="vertical" size="large" style={{ display: "flex" }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={t(
                    "systemSettings.realtimeSignals.runtime.summary.healthy",
                  )}
                  value={
                    diagnostics.sources.filter((row) => row.status === "ok")
                      .length
                  }
                  suffix={`/ ${diagnostics.sources.length}`}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={t(
                    "systemSettings.realtimeSignals.runtime.summary.issues",
                  )}
                  value={runtimeIssues.length}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={t(
                    "systemSettings.realtimeSignals.runtime.summary.markerReadiness",
                  )}
                  value={
                    diagnostics.markerReadiness.newsMarkersReady
                      ? t("common.ok")
                      : t("common.unavailable")
                  }
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={t(
                    "systemSettings.realtimeSignals.runtime.summary.pizzint",
                  )}
                  value={diagnostics.insight.pizzint?.defcon ?? "—"}
                />
              </Card>
            </Col>
          </Row>

          <RealtimeSignalsOpenskyBudgetPanel
            openskyBudget={diagnostics.openskyBudget}
            settings={settings}
          />

          <RealtimeSignalsMarkerReadiness
            markerReadiness={diagnostics.markerReadiness}
            formatTimestamp={formatTimestamp}
          />

          <RealtimeSignalsInsights insight={diagnostics.insight} />

          <Row gutter={[12, 12]}>
            {diagnostics.sources.map((row) => (
              <RealtimeSignalsSourceCard
                key={row.source}
                row={row}
                sourceName={sourceNameByKey[row.source] ?? row.source}
                acledApiDisabled={acledApiDisabled}
                formatTimestamp={formatTimestamp}
              />
            ))}
          </Row>
        </Space>
      ) : loading ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "1rem 0",
          }}
        >
          <Spin />
        </div>
      ) : (
        <Typography.Text type="secondary">
          {t("systemSettings.realtimeSignals.runtime.empty")}
        </Typography.Text>
      )}
    </Card>
  );
}
