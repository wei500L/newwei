import { AlertMetricProvider } from "@/graphql/generated";

import type { AlertEventItem } from "./alert-center.utils";
import { toNumber, toStringValue, isRecord } from "./evidence-utils";

/**
 * Alert Center 详情域纯派生模型（FE-批3B 从 alert-center.tsx 提取）。
 *
 * 输入 selectedEvent（+ locale 无关派生），输出详情页签共用的视图数据：
 * context 对象、additional context 键排除集、evidence 数值、feedback 元
 * 数据、reviewStatus。纯函数，无 React 依赖。
 */

export const CONTEXT_OBJECT_KEYS = [
  {
    key: "countryName",
    labelKey: "alerts.center.detail.object.country",
    defaultLabel: "Country",
  },
  {
    key: "countryCode",
    labelKey: "alerts.center.detail.object.countryCode",
    defaultLabel: "Country code",
  },
  {
    key: "resource",
    labelKey: "alerts.center.detail.object.resource",
    defaultLabel: "Resource",
  },
  {
    key: "action",
    labelKey: "alerts.center.detail.object.action",
    defaultLabel: "Action",
  },
  {
    key: "queueName",
    labelKey: "alerts.center.detail.object.queue",
    defaultLabel: "Queue",
  },
  {
    key: "sourceId",
    labelKey: "alerts.center.detail.object.source",
    defaultLabel: "Source",
  },
  {
    key: "createdById",
    labelKey: "alerts.center.detail.object.actor",
    defaultLabel: "Actor",
  },
  {
    key: "statuses",
    labelKey: "alerts.center.detail.object.statuses",
    defaultLabel: "Statuses",
  },
] as const;

export interface ContextObjectKeyEntry {
  key: string;
  labelKey: string;
  defaultLabel: string;
}

export interface AlertEventDetailModel {
  context: Record<string, unknown> | null;
  contextEntries: [string, unknown][];
  objectEntries: {
    key: string;
    label: string;
    value: unknown;
  }[];
  additionalContext: [string, unknown][];
  evidenceWindowMinutes: number | undefined;
  evidenceUnit: string | undefined;
  evidencePrevious: number | undefined;
  evidenceRecordedAt: string | number | undefined;
  evidenceSource: string | undefined;
  evidenceSourceDoc: string | undefined;
  feedback: Record<string, unknown> | null;
  feedbackStatus: string | undefined;
  feedbackUpdatedAt: string | number | undefined;
  feedbackUpdatedById: string | undefined;
  feedbackStoredNote: string | null;
  reviewStatus: "confirmed" | "ignored" | null;
  /** 事件 context.feedback.note（详情 note 预填来源）。 */
  feedbackPresetNote: string;
}

const buildExcludedContextKeys = (
  selectedEvent: AlertEventItem | null,
  objectKeys: string[],
): Set<string> => {
  const excluded = new Set([
    ...objectKeys,
    "feedback",
    "latest",
    "previous",
    "metricSlug",
    "threshold",
    "lower",
    "upper",
    "changePercent",
    "windowMinutes",
    "sourceName",
    "sourceEndpoint",
    "sourceFunction",
    "sourceDocUrl",
    "sourceField",
    "unit",
    "recordedAt",
    "itemName",
  ]);

  if (selectedEvent?.metricProvider === AlertMetricProvider.EconomicAnomaly) {
    [
      "observed",
      "expected",
      "sigma",
      "residual",
      "score",
      "model",
      "diagnostics",
      "fallback",
    ].forEach((key) => excluded.add(key));
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntitySentiment) {
    [
      "entityName",
      "entityType",
      "window",
      "baseline",
      "z",
      "minEntityConfidence",
      "evidence",
    ].forEach((key) => excluded.add(key));
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntityAssociation) {
    [
      "seed",
      "sourceEvent",
      "targets",
      "minAssociationWeight",
      "maxTargets",
    ].forEach((key) => excluded.add(key));
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.RealtimeSignal) {
    [
      "source",
      "stale",
      "latestTimestamp",
      "maxStaleMinutes",
      "countryCodes",
      "militaryCount",
      "disruptions",
      "outages",
      "unrestCount",
      "acledCount",
      "gdeltCount",
      "dedupeReducedBy",
      "defcon",
      "adjustedScore",
      "openLocations",
      "activeSpikes",
      "avgPop",
      "tensions",
      "leads",
      "spikes",
    ].forEach((key) => excluded.add(key));
  }

  return excluded;
};

/** 详情域视图模型：selectedEvent → 页签共用派生（纯函数）。 */
export function buildAlertEventDetailModel(
  selectedEvent: AlertEventItem | null,
  objectKeyLabels: { key: string; label: string }[],
): AlertEventDetailModel {
  const context =
    selectedEvent?.context && typeof selectedEvent.context === "object"
      ? (selectedEvent.context as Record<string, unknown>)
      : null;
  const contextEntries = context ? Object.entries(context) : [];
  const objectEntries = objectKeyLabels
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: context?.[entry.key],
    }))
    .filter(
      (entry) =>
        entry.value !== null && entry.value !== undefined && entry.value !== "",
    );

  const excludedContextKeys = buildExcludedContextKeys(
    selectedEvent,
    objectKeyLabels.map((entry) => entry.key),
  );
  const additionalContext = contextEntries.filter(
    ([key]) => !excludedContextKeys.has(key),
  );

  const evidenceWindowMinutes =
    selectedEvent?.changeWindowMin ?? toNumber(context?.windowMinutes);
  const evidenceUnit = toStringValue(context?.unit);
  const evidencePrevious = toNumber(context?.previous);
  const evidenceRecordedAt =
    typeof context?.recordedAt === "string" ||
    typeof context?.recordedAt === "number"
      ? context?.recordedAt
      : undefined;
  const evidenceSource =
    toStringValue(context?.sourceName) ??
    toStringValue(context?.sourceEndpoint) ??
    toStringValue(context?.sourceFunction) ??
    toStringValue(context?.sourceField) ??
    toStringValue(context?.source) ??
    toStringValue(selectedEvent?.metricSlug);
  const evidenceSourceDoc = toStringValue(context?.sourceDocUrl);

  const feedback =
    context?.feedback &&
    typeof context.feedback === "object" &&
    !Array.isArray(context.feedback)
      ? (context.feedback as Record<string, unknown>)
      : null;
  const feedbackStatus = toStringValue(feedback?.status);
  const feedbackUpdatedAt =
    typeof feedback?.updatedAt === "string" ||
    typeof feedback?.updatedAt === "number"
      ? feedback.updatedAt
      : undefined;
  const feedbackUpdatedById = toStringValue(feedback?.updatedById);
  const feedbackStoredNote =
    typeof feedback?.note === "string" ? feedback.note : null;

  const reviewStatus =
    feedbackStatus === "confirmed" || feedbackStatus === "ignored"
      ? feedbackStatus
      : selectedEvent?.status === "confirmed" ||
          selectedEvent?.status === "ignored"
        ? selectedEvent.status
        : null;

  return {
    context,
    contextEntries,
    objectEntries,
    additionalContext,
    evidenceWindowMinutes,
    evidenceUnit,
    evidencePrevious,
    evidenceRecordedAt,
    evidenceSource,
    evidenceSourceDoc,
    feedback,
    feedbackStatus,
    feedbackUpdatedAt,
    feedbackUpdatedById,
    feedbackStoredNote,
    reviewStatus,
    feedbackPresetNote: typeof feedback?.note === "string" ? feedback.note : "",
  };
}

/** context.feedback.note 读取（note 预填 effect 的既有语义）。 */
export function readFeedbackPresetNote(
  selectedEvent: AlertEventItem | null,
): string {
  const context = isRecord(selectedEvent?.context)
    ? (selectedEvent.context as Record<string, unknown>)
    : null;
  const feedback = isRecord(context?.feedback)
    ? (context.feedback as Record<string, unknown>)
    : null;
  return typeof feedback?.note === "string" ? feedback.note : "";
}
