"use client";

import { Button, Input, Space, Spin, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { AlertRuleTuningSuggestionQuery } from "@/graphql/generated";
import { formatDateTime, type resolveLocale } from "@/lib/i18n";

import type { AlertEventItem } from "./alert-center-list-model";
import { buildAlertEventDetailModel } from "./alert-event-detail-model";
import { DetailRow } from "./evidence-utils";

/**
 * Alert Center 详情 Feedback 页签（FE-批3B 从 alert-center.tsx 提取）。
 * 复核状态/note 预填（编排层 effect）/确认/忽略/一键确认 + tuning 建议。
 * `alerts.manage` 无权限时只读（按钮不渲染 + 文案提示）。
 */

export interface AlertEventFeedbackTabProps {
  selectedEvent: AlertEventItem;
  locale: ReturnType<typeof resolveLocale>;
  objectKeyLabels: { key: string; label: string }[];
  canManageAlerts: boolean;
  feedbackNote: string;
  onSetFeedbackNote: (note: string) => void;
  updatingStatus: boolean;
  onEventStatusUpdate: (status: "confirmed" | "ignored") => void;
  onQuickConfirm: () => void;
  tuningData: AlertRuleTuningSuggestionQuery | undefined;
  tuningLoading: boolean;
  tuningError: Error | undefined;
}

export function AlertEventFeedbackTab({
  selectedEvent,
  locale,
  objectKeyLabels,
  canManageAlerts,
  feedbackNote,
  onSetFeedbackNote,
  updatingStatus,
  onEventStatusUpdate,
  onQuickConfirm,
  tuningData,
  tuningLoading,
  tuningError,
}: AlertEventFeedbackTabProps) {
  const { t } = useTranslation();

  const model = buildAlertEventDetailModel(selectedEvent, objectKeyLabels);
  const { reviewStatus, feedbackUpdatedAt, feedbackUpdatedById, feedbackStoredNote } =
    model;

  const feedbackUpdatedAtLabel = feedbackUpdatedAt
    ? formatDateTime(feedbackUpdatedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : "";

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DetailRow label={t("alerts.center.detail.feedback")}>
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Space size="small" wrap>
            {reviewStatus ? (
              <Tag color={reviewStatus === "confirmed" ? "green" : "default"}>
                {reviewStatus}
              </Tag>
            ) : (
              <Tag>{t("alerts.center.detail.unreviewed")}</Tag>
            )}
            {feedbackUpdatedAtLabel ? (
              <Typography.Text type="secondary">
                {t("alerts.center.detail.feedbackUpdatedAt", {
                  time: feedbackUpdatedAtLabel,
                })}
              </Typography.Text>
            ) : null}
            {feedbackUpdatedById ? (
              <Typography.Text type="secondary">
                {t("alerts.center.detail.feedbackUpdatedBy", {
                  user: feedbackUpdatedById,
                })}
              </Typography.Text>
            ) : null}
          </Space>

          {feedbackStoredNote ? (
            <Typography.Text>{feedbackStoredNote}</Typography.Text>
          ) : reviewStatus ? (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.feedbackEmpty")}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.feedbackNotReviewed")}
            </Typography.Text>
          )}

          {canManageAlerts ? (
            <>
              <Input.TextArea
                id="alerts-feedback-note"
                name="alertsFeedbackNote"
                value={feedbackNote}
                onChange={(event) => onSetFeedbackNote(event.target.value)}
                rows={2}
                placeholder={t(
                  "alerts.center.detail.feedbackNotePlaceholder",
                )}
              />
              <Space wrap>
                <Button
                  type="primary"
                  size="small"
                  loading={updatingStatus}
                  onClick={() => onEventStatusUpdate("confirmed")}
                >
                  {t("alerts.center.detail.confirm")}
                </Button>
                <Button
                  size="small"
                  loading={updatingStatus}
                  onClick={() => onEventStatusUpdate("ignored")}
                >
                  {t("alerts.center.detail.ignore")}
                </Button>
                <Button
                  size="small"
                  loading={updatingStatus}
                  onClick={onQuickConfirm}
                >
                  {t("alerts.center.actions.quickConfirm")}
                </Button>
              </Space>
            </>
          ) : (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.feedbackAdminOnly")}
            </Typography.Text>
          )}
        </Space>
      </DetailRow>

      <DetailRow label={t("alerts.center.detail.tuning")}>
        {canManageAlerts ? (
          tuningLoading ? (
            <Spin size="small" />
          ) : tuningError ? (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.tuningError")}
            </Typography.Text>
          ) : tuningData?.alertRuleTuningSuggestion ? (
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">
                {t("alerts.center.detail.tuningStats", {
                  reviewed:
                    tuningData.alertRuleTuningSuggestion.reviewedEvents,
                  confirmed:
                    tuningData.alertRuleTuningSuggestion.confirmedEvents,
                  ignored:
                    tuningData.alertRuleTuningSuggestion.ignoredEvents,
                  rate:
                    typeof tuningData.alertRuleTuningSuggestion
                      .falsePositiveRate === "number"
                      ? `${(tuningData.alertRuleTuningSuggestion.falsePositiveRate * 100).toFixed(1)}%`
                      : t("common.notAvailable"),
                })}
              </Typography.Text>
              {tuningData.alertRuleTuningSuggestion.message ? (
                <Typography.Text>
                  {tuningData.alertRuleTuningSuggestion.message}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">
                  {t("alerts.center.detail.tuningEmpty")}
                </Typography.Text>
              )}
              {typeof tuningData.alertRuleTuningSuggestion
                .suggestedThresholdValue === "number" ? (
                <Typography.Text type="secondary">
                  {t("alerts.center.detail.tuningThreshold", {
                    value:
                      tuningData.alertRuleTuningSuggestion
                        .suggestedThresholdValue,
                  })}
                </Typography.Text>
              ) : null}
              {typeof tuningData.alertRuleTuningSuggestion
                .suggestedThresholdLower === "number" ||
              typeof tuningData.alertRuleTuningSuggestion
                .suggestedThresholdUpper === "number" ? (
                <Typography.Text type="secondary">
                  {t("alerts.center.detail.tuningRange", {
                    lower:
                      tuningData.alertRuleTuningSuggestion
                        .suggestedThresholdLower ??
                      t("common.notAvailable"),
                    upper:
                      tuningData.alertRuleTuningSuggestion
                        .suggestedThresholdUpper ??
                      t("common.notAvailable"),
                  })}
                </Typography.Text>
              ) : null}
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {t("common.notAvailable")}
            </Typography.Text>
          )
        ) : (
          <Typography.Text type="secondary">
            {t("alerts.center.detail.feedbackAdminOnly")}
          </Typography.Text>
        )}
      </DetailRow>
    </Space>
  );
}
