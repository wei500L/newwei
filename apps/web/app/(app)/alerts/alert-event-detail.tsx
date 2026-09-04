"use client";

import { Alert, Button, Card, Space, Tabs } from "antd";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";

import type {
  AlertEventDetailAnalysis,
  AlertEventDetailClipboard,
  AlertEventDetailFeedback,
  AlertEventDetailModel,
  AlertEventDetailNavigation,
  AlertEventDetailReplay,
  AlertEventDetailTheme,
  AlertEventDetailView,
} from "./alert-event-controllers";
import { AlertEventDeliveriesTab } from "./alert-event-deliveries-tab";
import { AlertEventEvidenceTab } from "./alert-event-evidence-tab";
import { AlertEventFeedbackTab } from "./alert-event-feedback-tab";
import { AlertEventOverviewTab } from "./alert-event-overview-tab";
import { AlertEventReplayTab } from "./alert-event-replay-tab";

/**
 * Alert Center 详情域编排（FE-批3B 从 alert-center.tsx 提取，
 * 第四轮收口：消费领域契约而非平铺字段）。
 *
 * - 五个页签：overview / evidence / replay / feedback / deliveries；
 * - filtered-out 保留提示（选中事件被当前筛选排除时）；
 * - previous/next 切换与 Copy Markdown 操作（extra 区，navigation 切片）；
 * - replay 懒加载门禁（detailTab==="replay" 且存在事件）在编排层；
 * - detailTab/expand 状态重置（selectedEventId 变化）在编排层。
 */

export interface AlertEventDetailProps {
  model: AlertEventDetailModel;
  navigation: AlertEventDetailNavigation;
  view: AlertEventDetailView;
  clipboard: AlertEventDetailClipboard;
  analysis: AlertEventDetailAnalysis;
  replay: AlertEventDetailReplay;
  feedback: AlertEventDetailFeedback;
  theme: AlertEventDetailTheme;
}

export function AlertEventDetail(props: AlertEventDetailProps) {
  const { model, navigation, view, clipboard } = props;
  const { selectedEvent, isFilteredOut, locale, objectKeyLabels } = model;
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
            onClick={() =>
              navigation.previousEventId &&
              navigation.selectEvent(navigation.previousEventId)
            }
            disabled={!navigation.previousEventId}
          >
            {t("alerts.center.actions.previous")}
          </Button>
          <Button
            size="small"
            onClick={() =>
              navigation.nextEventId && navigation.selectEvent(navigation.nextEventId)
            }
            disabled={!navigation.nextEventId}
          >
            {t("alerts.center.actions.next")}
          </Button>
          <Button
            size="small"
            onClick={clipboard.copyAlertMarkdown}
            disabled={!selectedEvent}
          >
            {t("alerts.center.actions.copyMarkdown")}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {isFilteredOut ? (
          <Alert
            type="warning"
            showIcon
            message={t("alerts.center.actions.filteredOut")}
          />
        ) : null}
        <Tabs
          activeKey={view.detailTab}
          onChange={view.setDetailTab}
          items={[
            {
              key: "overview",
              label: t("alerts.center.tabs.overview"),
              children: (
                <AlertEventOverviewTab
                  selectedEvent={selectedEvent}
                  locale={locale}
                  objectKeyLabels={objectKeyLabels}
                  expandMessage={view.expandMessage}
                  expandContext={view.expandContext}
                  onToggleExpandMessage={view.toggleExpandMessage}
                  onToggleExpandContext={view.toggleExpandContext}
                  onCopyRawContext={clipboard.copyRawContext}
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
                  similarAlerts={props.analysis.similarAlerts}
                  ruleTrendAnalysis={props.analysis.ruleTrendAnalysis}
                  ruleTrendOption={props.analysis.ruleTrendOption}
                  echartsTheme={props.theme.echartsTheme}
                  colors={props.theme.colors}
                  fontFamily={props.theme.fontFamily}
                  onSelectEvent={navigation.selectEvent}
                  onOpenEvent={navigation.openEvent}
                />
              ),
            },
            {
              key: "replay",
              label: t("alerts.center.tabs.replay"),
              children: (
                <AlertEventReplayTab
                  selectedEvent={selectedEvent}
                  replay={props.replay.replay}
                  replayPoints={props.replay.replayPoints}
                  replayLoading={props.replay.replayLoading}
                  replayError={props.replay.replayError}
                  replayOption={props.replay.replayOption}
                  echartsTheme={props.theme.echartsTheme}
                  onReloadReplay={props.replay.reloadReplay}
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
                  canManageAlerts={props.feedback.canManageAlerts}
                  feedbackNote={props.feedback.feedbackNote}
                  onSetFeedbackNote={props.feedback.setFeedbackNote}
                  updatingStatus={props.feedback.updatingStatus}
                  onEventStatusUpdate={props.feedback.eventStatusUpdate}
                  onQuickConfirm={props.feedback.quickConfirm}
                  tuningData={props.feedback.tuning.data}
                  tuningLoading={props.feedback.tuning.loading}
                  tuningError={props.feedback.tuning.error}
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
