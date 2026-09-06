"use client";

import {
  Alert,
  Card,
  Col,
  Space,
  Tag,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";

import {
  formatAisRuntimeReason,
  formatRealtimeSignalErrorCode,
} from "@/lib/realtime-signals-runtime";

import type { RealtimeSignalRuntimeDiagnosticsSource } from "./realtime-signals-types";
import {
  buildRuntimeFeedbackAlert,
  extractAisDiagnosticsView,
  formatOpenskyErrorKindLabel,
  formatOpenskyRuntimeReason,
  runtimeFreshnessColor,
  runtimeStatusColor,
  runtimeStatusLabel,
  summarizeRuntimeContext,
} from "./realtime-signals-runtime-model";

export interface RealtimeSignalsSourceCardProps {
  row: RealtimeSignalRuntimeDiagnosticsSource;
  sourceName: string;
  acledApiDisabled: boolean;
  formatTimestamp: (value?: string) => string;
}

export function RealtimeSignalsSourceCard({
  row,
  sourceName,
  acledApiDisabled,
  formatTimestamp,
}: RealtimeSignalsSourceCardProps) {
  const { t } = useTranslation();
  const openskySnapshot = row.openskySnapshot ?? row.adsbSnapshot;
  const summary = summarizeRuntimeContext(
    t,
    row.source,
    row.context,
    row.aisDiagnostics,
    openskySnapshot,
  );
  const runtimeStatusReason =
    row.source === "opensky"
      ? formatOpenskyRuntimeReason(t, row.statusReasonCode, row.statusReason)
      : row.source === "ais"
        ? formatAisRuntimeReason(t, row.statusReasonCode, row.statusReason)
        : row.statusReason;
  const runtimeFeedbackAlert = buildRuntimeFeedbackAlert(
    t,
    row,
    formatTimestamp,
  );
  const showRuntimeStatusReason =
    Boolean(runtimeStatusReason) &&
    runtimeStatusReason !== runtimeFeedbackAlert?.message &&
    runtimeStatusReason !== runtimeFeedbackAlert?.description;
  const openskyErrorKindLabel =
    row.source === "opensky"
      ? formatOpenskyErrorKindLabel(t, row.lastErrorKind)
      : undefined;
  const errorCodeLabel =
    row.source !== "opensky"
      ? formatRealtimeSignalErrorCode(t, row.lastErrorCode)
      : undefined;
  const aisView = extractAisDiagnosticsView(row);

  return (
    <Col xs={24} lg={12}>
      <Card
        size="small"
        title={sourceName}
        extra={
          <Space wrap size={[8, 8]}>
            {row.source === "unrest" && acledApiDisabled ? (
              <Tag color="gold">
                {t(
                  "systemSettings.realtimeSignals.runtime.unrestModeGdeltOnly",
                )}
              </Tag>
            ) : null}
            <Tag color={runtimeStatusColor(row.status)}>
              {runtimeStatusLabel(t, row.status)}
            </Tag>
            <Tag color={row.enabled ? "green" : "default"}>
              {row.source === "opensky"
                ? t(
                    "systemSettings.realtimeSignals.runtime.effectiveIntervalTag",
                    {
                      value: row.intervalSec,
                    },
                  )
                : `${row.intervalSec}s`}
            </Tag>
            {typeof row.configuredIntervalSec === "number" ? (
              <Tag color="default">
                {t(
                  "systemSettings.realtimeSignals.runtime.configuredIntervalTag",
                  {
                    value: row.configuredIntervalSec,
                  },
                )}
              </Tag>
            ) : null}
          </Space>
        }
      >
        <Space direction="vertical" size="small" style={{ display: "flex" }}>
          <Space wrap size={[8, 8]}>
            <Typography.Text strong>
              {t("systemSettings.realtimeSignals.runtime.latestValue")}:{" "}
              {row.latestValue ?? "—"}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t("systemSettings.realtimeSignals.runtime.previousValue")}:{" "}
              {row.previousValue ?? "—"}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t("systemSettings.realtimeSignals.runtime.changePercent")}:{" "}
              {typeof row.changePercent === "number"
                ? `${row.changePercent.toFixed(2)}%`
                : "—"}
            </Typography.Text>
          </Space>
          {summary ? (
            <Typography.Text type="secondary">{summary}</Typography.Text>
          ) : null}
          {row.source === "unrest" && acledApiDisabled ? (
            <Typography.Text type="secondary">
              {t("systemSettings.realtimeSignals.runtime.unrestAcledDisabled")}
            </Typography.Text>
          ) : null}
          {openskySnapshot ? (
            <Space wrap size={[8, 8]}>
              <Tag color={runtimeFreshnessColor(openskySnapshot.freshness)}>
                {t(
                  "systemSettings.realtimeSignals.runtime.openskySnapshotFreshness",
                )}
                :{" "}
                {t(
                  `systemSettings.realtimeSignals.runtime.openskyFreshness.${openskySnapshot.freshness}`,
                  {
                    defaultValue: openskySnapshot.freshness,
                  },
                )}
              </Tag>
              <Tag>
                {t(
                  "systemSettings.realtimeSignals.runtime.openskyMapPoints",
                )}
                : {openskySnapshot.snapshotValidPositionCount}
              </Tag>
              <Tag>
                {t(
                  "systemSettings.realtimeSignals.runtime.openskyCurrentValidPoints",
                )}
                : {openskySnapshot.currentValidPositionCount}
              </Tag>
              <Tag>
                {t(
                  "systemSettings.realtimeSignals.runtime.openskyDroppedStale",
                )}
                : {openskySnapshot.droppedStalePositionCount}
              </Tag>
            </Space>
          ) : null}
          {row.source === "ais" ? (
            <Space wrap size={[8, 8]}>
              {aisView.trackedVessels !== null ? (
                <Tag>
                  {t(
                    "systemSettings.realtimeSignals.runtime.aisTrackedVessels",
                  )}
                  : {aisView.trackedVessels}
                </Tag>
              ) : null}
              {aisView.candidates !== null ? (
                <Tag>
                  {t(
                    "systemSettings.realtimeSignals.runtime.aisCandidates",
                  )}
                  : {aisView.candidates}
                </Tag>
              ) : null}
              {aisView.reportsSeen !== null ? (
                <Tag>
                  {t(
                    "systemSettings.realtimeSignals.runtime.aisReportsSeen",
                  )}
                  : {aisView.reportsSeen}
                </Tag>
              ) : null}
              {aisView.reportsProcessed !== null ? (
                <Tag color="green">
                  {t(
                    "systemSettings.realtimeSignals.runtime.aisReportsProcessed",
                  )}
                  : {aisView.reportsProcessed}
                </Tag>
              ) : null}
              {aisView.reportsIgnored !== null ? (
                <Tag
                  color={aisView.reportsIgnored > 0 ? "gold" : "default"}
                >
                  {t(
                    "systemSettings.realtimeSignals.runtime.aisReportsIgnored",
                  )}
                  : {aisView.reportsIgnored}
                </Tag>
              ) : null}
              {aisView.parseErrors !== null ? (
                <Tag
                  color={aisView.parseErrors > 0 ? "volcano" : "default"}
                >
                  {t(
                    "systemSettings.realtimeSignals.runtime.aisParseErrors",
                  )}
                  : {aisView.parseErrors}
                </Tag>
              ) : null}
            </Space>
          ) : null}
          {openskySnapshot?.latestObservedAt ? (
            <Typography.Text type="secondary">
              {t(
                "systemSettings.realtimeSignals.runtime.openskyLatestObservedAt",
              )}
              : {formatTimestamp(openskySnapshot.latestObservedAt)}
              {typeof openskySnapshot.latestObservedAgeSec === "number"
                ? ` (${openskySnapshot.latestObservedAgeSec}s)`
                : ""}
            </Typography.Text>
          ) : null}
          {openskySnapshot?.snapshotUpdatedAt ? (
            <Typography.Text type="secondary">
              {t(
                "systemSettings.realtimeSignals.runtime.openskySnapshotUpdatedAt",
              )}
              : {formatTimestamp(openskySnapshot.snapshotUpdatedAt)}
              {typeof openskySnapshot.snapshotAgeSec === "number"
                ? ` (${openskySnapshot.snapshotAgeSec}s)`
                : ""}
            </Typography.Text>
          ) : null}
          {openskySnapshot?.retainedPreviousSnapshot ? (
            <Alert
              type="warning"
              showIcon
              message={t(
                "systemSettings.realtimeSignals.runtime.openskyRetainedPrevious",
              )}
            />
          ) : null}
          {runtimeFeedbackAlert ? (
            <Alert
              type={runtimeFeedbackAlert.type}
              showIcon
              message={runtimeFeedbackAlert.message}
              description={runtimeFeedbackAlert.description}
            />
          ) : null}
          {showRuntimeStatusReason ? (
            <Typography.Text type="secondary">
              {runtimeStatusReason}
            </Typography.Text>
          ) : null}
          {row.source === "ais" &&
          (aisView.lastUpstreamError || aisView.lastParseError) ? (
            <Alert
              type="warning"
              showIcon
              message={t(
                "systemSettings.realtimeSignals.runtime.aisRelayDiagnostics",
              )}
              description={[
                aisView.lastUpstreamError
                  ? `${t(
                      "systemSettings.realtimeSignals.runtime.aisLastUpstreamError",
                    )}: ${aisView.lastUpstreamError}`
                  : null,
                aisView.lastParseError
                  ? `${t(
                      "systemSettings.realtimeSignals.runtime.aisLastParseError",
                    )}: ${aisView.lastParseError}`
                  : null,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" | ")}
            />
          ) : null}
          <Space wrap size={[8, 8]}>
            <Tag>
              {t("systemSettings.realtimeSignals.runtime.lastRunAt")}:{" "}
              {formatTimestamp(row.lastRunAt)}
            </Tag>
            <Tag>
              {t("systemSettings.realtimeSignals.runtime.lastAttemptAt")}:{" "}
              {formatTimestamp(row.lastAttemptAt)}
            </Tag>
            <Tag>
              {t("systemSettings.realtimeSignals.runtime.nextEligibleAt")}:{" "}
              {formatTimestamp(row.nextEligibleAt)}
            </Tag>
            <Tag>
              {t("systemSettings.realtimeSignals.runtime.lastSuccessAt")}:{" "}
              {formatTimestamp(row.lastSuccessAt)}
            </Tag>
          </Space>
          {openskyErrorKindLabel ||
          errorCodeLabel ||
          typeof row.lastErrorStatus === "number" ? (
            <Space wrap size={[8, 8]}>
              {openskyErrorKindLabel ? (
                <Tag color="volcano">{openskyErrorKindLabel}</Tag>
              ) : null}
              {errorCodeLabel ? (
                <Tag color="default">{errorCodeLabel}</Tag>
              ) : null}
              {typeof row.lastErrorStatus === "number" ? (
                <Tag color="default">{`HTTP ${row.lastErrorStatus}`}</Tag>
              ) : null}
              {typeof row.lastRateLimit?.retryAfterSec === "number" ? (
                <Tag color="gold">
                  {t("systemSettings.realtimeSignals.runtime.retryAfter")}:{" "}
                  {`${row.lastRateLimit.retryAfterSec}s`}
                </Tag>
              ) : null}
            </Space>
          ) : null}
          {row.lastRateLimit ? (
            <Alert
              type="warning"
              showIcon
              message={t("systemSettings.realtimeSignals.runtime.rateLimit")}
              description={[
                row.lastRateLimit.rateLimit
                  ? `${t(
                      "systemSettings.realtimeSignals.runtime.rateLimitHeader",
                    )}: ${row.lastRateLimit.rateLimit}`
                  : null,
                row.lastRateLimit.rateLimitPolicy
                  ? `${t(
                      "systemSettings.realtimeSignals.runtime.rateLimitPolicy",
                    )}: ${row.lastRateLimit.rateLimitPolicy}`
                  : null,
                row.lastRateLimit.cfRay
                  ? `${t(
                      "systemSettings.realtimeSignals.runtime.cfRay",
                    )}: ${row.lastRateLimit.cfRay}`
                  : null,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" | ")}
            />
          ) : null}
          {row.lastError ? (
            <Alert
              type="error"
              showIcon
              message={t("systemSettings.realtimeSignals.runtime.lastError")}
              description={`${row.lastError}${row.lastErrorAt ? ` (${formatTimestamp(row.lastErrorAt)})` : ""}`}
            />
          ) : null}
        </Space>
      </Card>
    </Col>
  );
}
