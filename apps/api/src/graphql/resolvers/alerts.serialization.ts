import type {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
} from "@prisma/client";

import type { AlertEventPayload } from "../../modules/alerts/alerts.pubsub";
import type { AlertEventModel } from "../models/alert.model";

interface AlertDeliverySource {
  id: string;
  status: AlertDeliveryStatus;
  error?: string | null;
  sentAt?: Date | null;
  channelType: AlertChannelType;
  channel?: {
    name?: string | null;
    target?: string | null;
  } | null;
  targetSnapshot?: unknown;
}

interface AlertRuleSource {
  name?: string | null;
  metricProvider?: AlertMetricProvider | null;
  metricSlug?: string | null;
  operator?: AlertOperator | null;
  thresholdValue?: unknown;
  thresholdLower?: unknown;
  thresholdUpper?: unknown;
  changeWindowMin?: number | null;
}

interface AlertEventSerializationSource {
  id: string;
  triggeredAt: Date | string;
  metricValue: unknown;
  changePercent?: unknown;
  severity: AlertSeverity;
  status: AlertEventStatus;
  message?: string | null;
  ruleId?: string | null;
  ruleName?: string | null;
  metricProvider?: AlertMetricProvider | null;
  metricSlug?: string | null;
  operator?: AlertOperator | null;
  thresholdValue?: unknown;
  thresholdLower?: unknown;
  thresholdUpper?: unknown;
  changeWindowMin?: number | null;
  context?: unknown;
  deliveries?: AlertDeliverySource[];
  rule?: AlertRuleSource | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const normalizeRequiredMetricSlug = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const normalizeOptionalMetricSlug = (
  value: unknown,
): string | undefined => {
  const normalized = normalizeRequiredMetricSlug(value);
  return normalized || undefined;
};

export const serializeOptionalFiniteNumber = (
  value: unknown,
): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized =
    typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
};

export const serializeRequiredFiniteNumber = (value: unknown): number =>
  // GraphQL numeric scalars cannot represent NaN/Infinity.
  serializeOptionalFiniteNumber(value) ?? 0;

const serializeAlertDelivery = (delivery: AlertDeliverySource) => {
  const snapshot = isRecord(delivery.targetSnapshot)
    ? delivery.targetSnapshot
    : null;
  const snapshotTarget =
    typeof snapshot?.target === "string"
      ? snapshot.target
      : typeof snapshot?.userId === "string"
        ? snapshot.userId
        : undefined;
  const snapshotName =
    typeof snapshot?.name === "string" ? snapshot.name : undefined;

  return {
    id: delivery.id,
    status: delivery.status,
    error: delivery.error ?? undefined,
    sentAt: delivery.sentAt ?? undefined,
    channelType: delivery.channelType,
    channelName:
      delivery.channel?.name ??
      snapshotName ??
      (delivery.channelType === "in_app" ? "In-app" : undefined),
    target: delivery.channel?.target ?? snapshotTarget,
  };
};

export const serializeAlertEvent = (
  source: AlertEventSerializationSource,
): AlertEventModel => {
  const triggeredAt =
    source.triggeredAt instanceof Date
      ? source.triggeredAt
      : new Date(source.triggeredAt);
  const rule = source.rule ?? null;

  return {
    id: source.id,
    triggeredAt,
    metricValue: serializeRequiredFiniteNumber(source.metricValue),
    changePercent: serializeOptionalFiniteNumber(source.changePercent),
    severity: source.severity,
    status: source.status,
    message: source.message ?? undefined,
    ruleId: source.ruleId ?? undefined,
    ruleName: source.ruleName ?? rule?.name ?? undefined,
    metricProvider:
      source.metricProvider ?? rule?.metricProvider ?? undefined,
    metricSlug: normalizeOptionalMetricSlug(
      source.metricSlug ?? rule?.metricSlug,
    ),
    operator: source.operator ?? rule?.operator ?? undefined,
    thresholdValue: serializeOptionalFiniteNumber(
      source.thresholdValue ?? rule?.thresholdValue,
    ),
    thresholdLower: serializeOptionalFiniteNumber(
      source.thresholdLower ?? rule?.thresholdLower,
    ),
    thresholdUpper: serializeOptionalFiniteNumber(
      source.thresholdUpper ?? rule?.thresholdUpper,
    ),
    changeWindowMin: source.changeWindowMin ?? rule?.changeWindowMin ?? null,
    context: isRecord(source.context)
      ? source.context
      : null,
    deliveries: (source.deliveries ?? []).map(serializeAlertDelivery),
  };
};

export const serializeAlertEventPayload = (
  payload: AlertEventPayload,
): AlertEventModel =>
  serializeAlertEvent({
    ...payload.event,
    deliveries: [],
  });
