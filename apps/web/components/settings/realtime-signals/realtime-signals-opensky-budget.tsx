"use client";

import {
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
} from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  buildOpenskyBudgetView,
  formatPercentValue,
  openskyBudgetDegradationColor,
} from "./realtime-signals-runtime-model";
import type {
  RealtimeOpenskyBudgetSummary,
  RealtimeSignalsSettingsResponse,
} from "./realtime-signals-types";

export interface RealtimeSignalsOpenskyBudgetProps {
  openskyBudget: RealtimeOpenskyBudgetSummary | undefined;
  settings: RealtimeSignalsSettingsResponse;
}

export function RealtimeSignalsOpenskyBudgetPanel({
  openskyBudget,
  settings,
}: RealtimeSignalsOpenskyBudgetProps) {
  const { t } = useTranslation();
  const { periodLabel, degradationLabel, errorBreakdown } =
    buildOpenskyBudgetView(t, openskyBudget);

  const openskyBudgetColumns = useMemo(
    () => [
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.date",
        ),
        dataIndex: "dateHkt",
        key: "dateHkt",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.usedCredits",
        ),
        dataIndex: "usedCredits",
        key: "usedCredits",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.militaryCredits",
        ),
        dataIndex: "militaryCredits",
        key: "militaryCredits",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.allCredits",
        ),
        dataIndex: "allCredits",
        key: "allCredits",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.calls",
        ),
        dataIndex: "requestCount",
        key: "requestCount",
      },
    ],
    [t],
  );

  return (
    <Card
      size="small"
      title={t("systemSettings.realtimeSignals.runtime.openskyBudget.title")}
    >
      <Space direction="vertical" size="middle" style={{ display: "flex" }}>
        <Space wrap size={[8, 8]}>
          <Tag color="geekblue">
            {t("systemSettings.realtimeSignals.runtime.openskyBudget.date")}:{" "}
            {openskyBudget?.dateHkt ?? "—"}
          </Tag>
          <Tag color="purple">
            {t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.timezone",
            )}
            : {openskyBudget?.timezone ?? "Asia/Hong_Kong"}
          </Tag>
          <Tag
            color={openskyBudgetDegradationColor(
              openskyBudget?.degradationLevel,
            )}
          >
            {t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.degradationLabel",
            )}
            : {degradationLabel}
          </Tag>
          {openskyBudget?.allModeBlocked ? (
            <Tag color="magenta">
              {t(
                "systemSettings.realtimeSignals.runtime.openskyBudget.allModeBlocked",
              )}
            </Tag>
          ) : null}
        </Space>

        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic
                title={t(
                  "systemSettings.realtimeSignals.runtime.openskyBudget.dailyBudget",
                )}
                value={openskyBudget?.dailyBudget ?? "—"}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic
                title={t(
                  "systemSettings.realtimeSignals.runtime.openskyBudget.usedCredits",
                )}
                value={openskyBudget?.usedCredits ?? "—"}
                suffix={
                  openskyBudget
                    ? `/ ${formatPercentValue(openskyBudget.usagePct)}`
                    : undefined
                }
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic
                title={t(
                  "systemSettings.realtimeSignals.runtime.openskyBudget.remainingCredits",
                )}
                value={openskyBudget?.remainingCredits ?? "—"}
                suffix={
                  openskyBudget
                    ? `/ ${formatPercentValue(openskyBudget.remainingPct)}`
                    : undefined
                }
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card size="small">
              <Statistic
                title={t(
                  "systemSettings.realtimeSignals.runtime.openskyBudget.currentPeriod",
                )}
                value={periodLabel}
              />
            </Card>
          </Col>
        </Row>

        <Descriptions size="small" bordered column={1}>
          <Descriptions.Item
            label={t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.effectiveInterval",
            )}
          >
            {typeof openskyBudget?.effectiveMilitaryIntervalSec === "number"
              ? `${openskyBudget.effectiveMilitaryIntervalSec}s`
              : "—"}
          </Descriptions.Item>
          <Descriptions.Item
            label={t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.configuredSchedule",
            )}
          >
            {openskyBudget
              ? `${openskyBudget.dayIntervalSec}s (${settings.openskyDayStartHourHkt.toString().padStart(2, "0")}:00-${settings.openskyNightStartHourHkt.toString().padStart(2, "0")}:00) / ${openskyBudget.nightIntervalSec}s (${settings.openskyNightStartHourHkt.toString().padStart(2, "0")}:00-${settings.openskyDayStartHourHkt.toString().padStart(2, "0")}:00)`
              : "—"}
          </Descriptions.Item>
          <Descriptions.Item
            label={t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.calls",
            )}
          >
            {openskyBudget
              ? `${openskyBudget.requestCount} charged / ${openskyBudget.militaryCalls} military / ${openskyBudget.allCalls} all / ${openskyBudget.errorCalls} errors`
              : "—"}
          </Descriptions.Item>
          <Descriptions.Item
            label={t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.errorBreakdown",
            )}
          >
            {errorBreakdown}
          </Descriptions.Item>
          <Descriptions.Item
            label={t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.resetAt",
            )}
          >
            {t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.resetAtValue",
            )}
          </Descriptions.Item>
          <Descriptions.Item
            label={t(
              "systemSettings.realtimeSignals.runtime.openskyBudget.blockedCounts",
            )}
          >
            {openskyBudget
              ? `${openskyBudget.blockedAllModeCount} all blocked / ${openskyBudget.skippedMilitaryCount} military skipped`
              : "—"}
          </Descriptions.Item>
        </Descriptions>

        <Table
          size="small"
          pagination={false}
          columns={openskyBudgetColumns}
          dataSource={openskyBudget?.recentDays ?? []}
          rowKey="dateHkt"
        />
      </Space>
    </Card>
  );
}
