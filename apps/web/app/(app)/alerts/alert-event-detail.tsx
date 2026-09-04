"use client";

import { Alert, Button, Card, Space, Tabs } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import type {
  AlertEventReplayQuery,
  AlertRuleTuningSuggestionQuery,
} from "@/graphql/generated";
import type { resolveLocale } from "@/lib/i18n";

import type { AlertEventItem } from "./alert-center-list-model";
import { AlertEventDeliveriesTab } from "./alert-event-deliveries-tab";
import { AlertEventEvidenceTab } from "./alert-event-evidence-tab";
import { AlertEventFeedbackTab } from "./alert-event-feedback-tab";
import { AlertEventOverviewTab } from "./alert-event-overview-tab";
import { AlertEventReplayTab } from "./alert-event-replay-tab";

type ReplayModel = NonNullable<AlertEventReplayQuery["alertEventReplay"]>;

/**
 * Alert Center 详情域编排（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - 五个页签：overview / evidence / replay / feedback / deliveries；
 * - filtered-out 保留提示（选中事件被当前筛选排除时）；
 * - previous/next 切换与 Copy Markdown 操作（extra 区）；
 * - replay 懒加载门禁（detailTab==="replay" 且存在事件）在编排层；
 * - detailTab/expand 状态重置（selectedEventId 变化）在编排层。
 */

export interface AlertEventDetailProps {
  selectedEvent: AlertEventItem | null;
  selectedEventId: string | null;
  selectedIndexInFiltered: number;
  filteredEvents: AlertEventItem[];
  locale: ReturnType<typeof resolveLocale>;
  objectKeyLabels: { key: string; label: string }[];
  detailTab: string;
  onSetDetailTab: (tab: string) => void;
  expandMessage: boolean;
  expandContext: boolean;
  onToggleExpandMessage: () => void;
  onToggleExpandContext: () => void;
  onCopyRawContext: () => void;
  onCopyAlertMarkdown: () => void;
  onSelectEvent: (eventId: string) => void;
  onOpenEvent: (eventId: string) => void;
  previousEventId: string | null;
  nextEventId: string | null;
  similarAlerts: { event: AlertEventItem; reason: "same_rule" | "same_metric" }[];
  ruleTrendAnalysis: {
    points: { date: string; triggers: number; falsePositiveRate: number | null }[];
    totalTriggers: number;
    averageDailyTriggers: number;
    falsePositiveRate: number | null;
  };
  ruleTrendOption: EChartsOption;
  replay: ReplayModel | null;
  replayPoints: ReplayModel["points"] | undefined;
  replayLoading: boolean;
  replayError: Error | undefined;
  replayOption: EChartsOption;
  onReloadReplay: () => void;
  canManageAlerts: boolean;
  feedbackNote: string;
  onSetFeedbackNote: (note: string) => void;
  updatingStatus: boolean;
  onEventStatusUpdate: (status: "confirmed" | "ignored") => void;
  onQuickConfirm: () => void;
  tuningData: AlertRuleTuningSuggestionQuery | undefined;
  tuningLoading: boolean;
  tuningError: Error | undefined;
  echartsTheme: string;
  colors: { primary: string; accent: string };
  fontFamily: string;
}

export function AlertEventDetail(props: AlertEventDetailProps) {
  const {
    selectedEvent,
    selectedIndexInFiltered,
    filteredEvents,
    locale,
    objectKeyLabels,
    detailTab,
    onSetDetailTab,
    expandMessage,
    expandContext,
    onToggleExpandMessage,
    onToggleExpandContext,
    onCopyRawContext,
    onCopyAlertMarkdown,
    previousEventId,
    nextEventId,
    onSelectEvent,
  } = props;
  const { t } = useTranslation();

  if (!selectedEvent) {
    return (
      <Card
        className="content-card"
        title={t("alerts.center.evidenceTitle")}
      >
        <ChartEmptyState
          className="h-auto py-6"
          description={t("alerts.center.selectEvent")}
        />
      </Card>
    );
  }

  return (
    <Card
      className="content-card"
      title={t("alerts.center.evidenceTitle")}
      extra={
        <Space wrap>
          <Button
            size="small"
            onClick={() => previousEventId && onSelectEvent(previousEventId)}
            disabled={!previousEventId}
          >
            {t("alerts.center.actions.previous")}
          </Button>
          <Button
            size="small"
            onClick={() => nextEventId && onSelectEvent(nextEventId)}
            disabled={!nextEventId}
          >
            {t("alerts.center.actions.next")}
          </Button>
          <Button size="small" onClick={onCopyAlertMarkdown} disabled={!selectedEvent}>
            {t("alerts.center.actions.copyMarkdown")}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {selectedIndexInFiltered === -1 && filteredEvents.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t("alerts.center.actions.filteredOut")}
          />
        ) : null}
        <Tabs
          activeKey={detailTab}
          onChange={onSetDetailTab}
          items={[
            {
              key: "overview",
              label: t("alerts.center.tabs.overview"),
              children: (
                <AlertEventOverviewTab
                  selectedEvent={selectedEvent}
                  locale={locale}
                  objectKeyLabels={objectKeyLabels}
                  expandMessage={expandMessage}
                  expandContext={expandContext}
                  onToggleExpandMessage={onToggleExpandMessage}
                  onToggleExpandContext={onToggleExpandContext}
                  onCopyRawContext={onCopyRawContext}
                />
              ),
            },
            {
              key: "evidence",
              label: t("alerts.center.tabs.evidence"),
              children: (
                <AlertEventEvidenceTab
                  selectedEvent={selectedEvent}
                  locale={locale}
                  objectKeyLabels={objectKeyLabels}
                  similarAlerts={props.similarAlerts}
                  ruleTrendAnalysis={props.ruleTrendAnalysis}
                  ruleTrendOption={props.ruleTrendOption}
                  echartsTheme={props.echartsTheme}
                  colors={props.colors}
                  fontFamily={props.fontFamily}
                  onSelectEvent={onSelectEvent}
                  onOpenEvent={props.onOpenEvent}
                />
              ),
            },
            {
              key: "replay",
              label: t("alerts.center.tabs.replay"),
              children: (
                <AlertEventReplayTab
                  selectedEvent={selectedEvent}
                  replay={props.replay}
                  replayPoints={props.replayPoints}
                  replayLoading={props.replayLoading}
                  replayError={props.replayError}
                  replayOption={props.replayOption}
                  echartsTheme={props.echartsTheme}
                  onReloadReplay={props.onReloadReplay}
                />
              ),
            },
            {
              key: "feedback",
              label: t("alerts.center.tabs.feedback"),
              children: (
                <AlertEventFeedbackTab
                  selectedEvent={selectedEvent}
                  locale={locale}
                  objectKeyLabels={objectKeyLabels}
                  canManageAlerts={props.canManageAlerts}
                  feedbackNote={props.feedbackNote}
                  onSetFeedbackNote={props.onSetFeedbackNote}
                  updatingStatus={props.updatingStatus}
                  onEventStatusUpdate={props.onEventStatusUpdate}
                  onQuickConfirm={props.onQuickConfirm}
                  tuningData={props.tuningData}
                  tuningLoading={props.tuningLoading}
                  tuningError={props.tuningError}
                />
              ),
            },
            {
              key: "deliveries",
              label: t("alerts.center.tabs.deliveries"),
              children: (
                <AlertEventDeliveriesTab
                  selectedEvent={selectedEvent}
                  locale={locale}
                />
              ),
            },
          ]}
        />
      </Space>
    </Card>
  );
}
