import type { NotificationType } from "@/graphql/generated";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import {
  formatRealtimeSocketError,
  type RealtimeSocketErrorPayload,
} from "@/lib/realtime-socket-errors";

export interface NotificationLink {
  href: string;
  label: string;
}

export interface NotificationPresentationItem {
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
}

export interface NotificationPresentationCopy {
  title: string;
  body?: string | null;
  toastText: string;
}

export interface NotificationStreamErrorPayload
  extends RealtimeSocketErrorPayload {}

export interface ResolveNotificationLinkOptions {
  canReadAlerts?: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface NotificationPresentationPayload {
  kind?: string;
  params?: Record<string, unknown>;
  technicalDetail?: string;
}

const NotificationPresentationKind = {
  CrawlCompleted: "crawl_completed",
  CrawlFailed: "crawl_failed",
  AnalysisCompleted: "analysis_completed",
  AnalysisFailed: "analysis_failed",
  AlertTriggered: "alert_triggered",
  NewsSourceCircuitOpened: "news_source_circuit_opened",
  NewsSourceAutoDisabled: "news_source_auto_disabled",
  NewsSourceRssBodyMissingSpike: "news_source_rss_body_missing_spike",
  NewsSourcePipelineRetrySpike: "news_source_pipeline_retry_spike",
  NewsSourceSchedulerBackpressure: "news_source_scheduler_backpressure",
  ClassificationQualityThresholdExceeded:
    "classification_quality_threshold_exceeded",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toNumberValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const formatCount = (
  value: number | undefined,
  locale: SupportedLocale,
): string =>
  value === undefined
    ? ""
    : new Intl.NumberFormat(locale).format(Math.trunc(value));

const formatNumber = (
  value: number | undefined,
  locale: SupportedLocale,
): string =>
  value === undefined
    ? ""
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

const formatPercent = (
  value: number | undefined,
  locale: SupportedLocale,
): string => (value === undefined ? "" : `${formatNumber(value, locale)}%`);

const formatTimestamp = (
  value: unknown,
  locale: SupportedLocale,
): string | undefined => {
  const iso = toStringValue(value);
  if (!iso) {
    return undefined;
  }
  const formatted = formatDateTime(iso, locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatted || undefined;
};

const joinSentences = (
  body: string | null | undefined,
  detail: string,
  locale: SupportedLocale,
): string => {
  if (!body) {
    return detail;
  }
  return locale === "zh-CN" ? `${body}${detail}` : `${body} ${detail}`;
};

const appendTechnicalDetail = (
  body: string | null | undefined,
  technicalDetail: string | undefined,
  locale: SupportedLocale,
  t: Translate,
): string | null | undefined => {
  if (!technicalDetail) {
    return body;
  }
  const detail = t("notifications.technicalDetail", {
    defaultValue: "System detail: {{detail}}",
    detail: technicalDetail,
  });
  return joinSentences(body, detail, locale);
};

const getPresentationPayload = (
  payload: Record<string, unknown> | null | undefined,
): NotificationPresentationPayload | null => {
  if (!payload || !isRecord(payload)) {
    return null;
  }
  const presentation = payload.presentation;
  if (!isRecord(presentation)) {
    return null;
  }
  return {
    kind: toStringValue(presentation.kind),
    params: isRecord(presentation.params) ? presentation.params : undefined,
    technicalDetail: toStringValue(
      presentation.technicalDetail ??
        (isRecord(presentation.params)
          ? (presentation.params.technicalDetail ??
            presentation.params.detail ??
            presentation.params.error ??
            presentation.params.errorMessage)
          : undefined),
    ),
  };
};

const getSourceLabel = (params: Record<string, unknown>): string | undefined =>
  toStringValue(
    params.sourceName ??
      params.sourceLabel ??
      params.sourceDisplayName ??
      params.sourceTitle ??
      params.sourceId,
  );

const getTaskLabel = (params: Record<string, unknown>): string | undefined =>
  toStringValue(
    params.taskLabel ??
      params.taskName ??
      params.displayName ??
      params.targetUrl ??
      params.taskId,
  );

const getAnalysisLabel = (
  params: Record<string, unknown>,
  t: Translate,
): string | undefined => {
  const raw = toStringValue(
    params.analysisLabel ?? params.analysisType ?? params.type,
  );
  if (!raw) {
    return undefined;
  }

  if (raw === "correlation" || raw === "anomaly") {
    return t(`notifications.analysisType.${raw}`, {
      defaultValue:
        raw === "correlation" ? "Correlation analysis" : "Anomaly analysis",
    });
  }

  return raw;
};

const getAlertContextSummary = (
  params: Record<string, unknown>,
): string | undefined => {
  const context = isRecord(params.context) ? params.context : params;
  const parts = [
    toStringValue(context.itemName),
    toStringValue(context.sourceName),
    toStringValue(context.countryName ?? context.countryCode),
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.slice(0, 3).join(" · ") : undefined;
};

export const formatNotificationPresentation = (
  item: NotificationPresentationItem,
  locale: SupportedLocale,
  t: Translate,
): NotificationPresentationCopy => {
  const fallback: NotificationPresentationCopy = {
    title: item.title,
    body: item.body ?? null,
    toastText: item.title,
  };

  const presentation = getPresentationPayload(item.data);
  if (!presentation?.kind || !presentation.params) {
    return fallback;
  }

  const { kind, params, technicalDetail } = presentation;

  switch (kind) {
    case NotificationPresentationKind.CrawlCompleted: {
      const taskLabel = getTaskLabel(params);
      if (!taskLabel) {
        return fallback;
      }
      const inserted = formatCount(toNumberValue(params.inserted), locale);
      const skipped = formatCount(toNumberValue(params.skipped), locale);
      const retryableFailures = toNumberValue(params.retryableFailures);
      const body = t("notifications.presentation.crawlCompleted.body", {
        defaultValue:
          "Inserted {{inserted}} item(s), skipped {{skipped}} item(s){{retryableSuffix}}.",
        inserted: inserted || "0",
        skipped: skipped || "0",
        retryableSuffix:
          retryableFailures && retryableFailures > 0
            ? t("notifications.presentation.crawlCompleted.retryableSuffix", {
                defaultValue: ", retryable failures {{count}}",
                count: formatCount(retryableFailures, locale),
              })
            : "",
      });
      const title = t("notifications.presentation.crawlCompleted.title", {
        defaultValue: "Crawl completed: {{taskLabel}}",
        taskLabel,
      });
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.CrawlFailed: {
      const taskLabel = getTaskLabel(params);
      if (!taskLabel) {
        return fallback;
      }
      const title = t("notifications.presentation.crawlFailed.title", {
        defaultValue: "Crawl failed: {{taskLabel}}",
        taskLabel,
      });
      const body = appendTechnicalDetail(
        t("notifications.presentation.crawlFailed.body", {
          defaultValue: "The crawl task did not complete successfully.",
        }),
        technicalDetail,
        locale,
        t,
      );
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.AnalysisCompleted: {
      const analysisLabel = getAnalysisLabel(params, t);
      if (!analysisLabel) {
        return fallback;
      }
      const summary =
        toStringValue(params.summary) ??
        toStringValue(params.resultSummary) ??
        item.body ??
        t("notifications.presentation.analysisCompleted.body", {
          defaultValue: "The analysis result is ready.",
        });
      const title = t("notifications.presentation.analysisCompleted.title", {
        defaultValue: "Analysis completed: {{analysisLabel}}",
        analysisLabel,
      });
      return { title, body: summary, toastText: title };
    }
    case NotificationPresentationKind.AnalysisFailed: {
      const analysisLabel = getAnalysisLabel(params, t);
      if (!analysisLabel) {
        return fallback;
      }
      const title = t("notifications.presentation.analysisFailed.title", {
        defaultValue: "Analysis failed: {{analysisLabel}}",
        analysisLabel,
      });
      const body = appendTechnicalDetail(
        t("notifications.presentation.analysisFailed.body", {
          defaultValue: "The analysis job did not complete successfully.",
        }),
        technicalDetail,
        locale,
        t,
      );
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.AlertTriggered: {
      const ruleName = toStringValue(
        params.ruleName ?? params.ruleTitle ?? params.metricLabel,
      );
      if (!ruleName) {
        return fallback;
      }
      const metricValue = formatNumber(
        toNumberValue(params.metricValue),
        locale,
      );
      const changePercent = formatPercent(
        toNumberValue(params.changePercent),
        locale,
      );
      const contextSummary = getAlertContextSummary(params);
      const details = [
        metricValue
          ? t("notifications.presentation.alertTriggered.metricValue", {
              defaultValue: "current value {{value}}",
              value: metricValue,
            })
          : null,
        changePercent
          ? t("notifications.presentation.alertTriggered.changePercent", {
              defaultValue: "change {{value}}",
              value: changePercent,
            })
          : null,
        contextSummary
          ? t("notifications.presentation.alertTriggered.context", {
              defaultValue: "context {{value}}",
              value: contextSummary,
            })
          : null,
      ].filter(Boolean) as string[];
      const triggerCondition = toStringValue(technicalDetail);
      const structuredDetail = details.length
        ? t("notifications.presentation.alertTriggered.body", {
            defaultValue: "Triggered alert condition: {{details}}.",
            details: details.join(locale === "zh-CN" ? "，" : ", "),
          })
        : null;
      const body =
        triggerCondition && structuredDetail
          ? joinSentences(triggerCondition, structuredDetail, locale)
          : (triggerCondition ?? structuredDetail ?? item.body ?? null);
      const title = t("notifications.presentation.alertTriggered.title", {
        defaultValue: "Alert triggered: {{ruleName}}",
        ruleName,
      });
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.NewsSourceCircuitOpened: {
      const sourceLabel = getSourceLabel(params);
      const until = formatTimestamp(params.circuitOpenUntil, locale);
      if (!sourceLabel || !until) {
        return fallback;
      }
      const title = t(
        "notifications.presentation.newsSourceCircuitOpened.title",
        {
          defaultValue: "Source paused: {{sourceLabel}}",
          sourceLabel,
        },
      );
      const body = t(
        "notifications.presentation.newsSourceCircuitOpened.body",
        {
          defaultValue:
            "Consecutive failures reached {{count}} and the source is paused until {{until}}.",
          count:
            formatCount(toNumberValue(params.consecutiveFailures), locale) ||
            "0",
          until,
        },
      );
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.NewsSourceAutoDisabled: {
      const sourceLabel = getSourceLabel(params);
      if (!sourceLabel) {
        return fallback;
      }
      const title = t(
        "notifications.presentation.newsSourceAutoDisabled.title",
        {
          defaultValue: "Source disabled: {{sourceLabel}}",
          sourceLabel,
        },
      );
      const body = t("notifications.presentation.newsSourceAutoDisabled.body", {
        defaultValue:
          "Consecutive failures reached {{count}} and the source was automatically disabled.",
        count:
          formatCount(toNumberValue(params.consecutiveFailures), locale) || "0",
      });
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.NewsSourceRssBodyMissingSpike: {
      const sourceLabel = getSourceLabel(params);
      if (!sourceLabel) {
        return fallback;
      }
      const title = t(
        "notifications.presentation.newsSourceRssBodyMissingSpike.title",
        {
          defaultValue: "RSS body missing spike: {{sourceLabel}}",
          sourceLabel,
        },
      );
      const body = t(
        "notifications.presentation.newsSourceRssBodyMissingSpike.body",
        {
          defaultValue:
            "In the last 24 hours, items without usable body reached {{count}}; threshold {{threshold}}.",
          count:
            formatCount(toNumberValue(params.sourceCount24h), locale) || "0",
          threshold:
            formatCount(toNumberValue(params.threshold), locale) || "0",
        },
      );
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.NewsSourcePipelineRetrySpike: {
      const sourceLabel = getSourceLabel(params);
      if (!sourceLabel) {
        return fallback;
      }
      const title = t(
        "notifications.presentation.newsSourcePipelineRetrySpike.title",
        {
          defaultValue: "Pipeline retry spike: {{sourceLabel}}",
          sourceLabel,
        },
      );
      const body = t(
        "notifications.presentation.newsSourcePipelineRetrySpike.body",
        {
          defaultValue:
            "In the last 24 hours, pipeline retries reached {{count}}; threshold {{threshold}}.",
          count:
            formatCount(toNumberValue(params.sourceCount24h), locale) || "0",
          threshold:
            formatCount(toNumberValue(params.threshold), locale) || "0",
        },
      );
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.NewsSourceSchedulerBackpressure: {
      const rescheduleAt = formatTimestamp(params.rescheduleAt, locale);
      if (!rescheduleAt) {
        return fallback;
      }
      const title = t(
        "notifications.presentation.newsSourceSchedulerBackpressure.title",
        {
          defaultValue: "Scheduler backpressure warning",
        },
      );
      const body = t(
        "notifications.presentation.newsSourceSchedulerBackpressure.body",
        {
          defaultValue:
            "{{delayedCount}} source(s) were delayed until {{rescheduleAt}}; pending jobs {{pendingJobs}}, threshold {{threshold}}.",
          delayedCount:
            formatCount(toNumberValue(params.delayedCount), locale) || "0",
          rescheduleAt,
          pendingJobs:
            formatCount(toNumberValue(params.pendingJobs), locale) || "0",
          threshold:
            formatCount(toNumberValue(params.threshold), locale) || "0",
        },
      );
      return { title, body, toastText: title };
    }
    case NotificationPresentationKind.ClassificationQualityThresholdExceeded: {
      const title = t(
        "notifications.presentation.classificationQualityThresholdExceeded.title",
        {
          defaultValue: "Classification quality threshold exceeded",
        },
      );
      const window =
        toStringValue(params.window) ??
        t("common.notAvailable", { defaultValue: "N/A" });
      const latencySummary = toStringValue(
        params.latencySummary ?? params.latencyAlertSummary,
      );
      const gateSummary = toStringValue(
        params.gateSummary ?? params.gateAlertSummary,
      );
      const semanticBody =
        latencySummary || gateSummary
          ? [
              latencySummary
                ? t(
                    "notifications.presentation.classificationQualityThresholdExceeded.latency",
                    {
                      defaultValue: "Latency: {{summary}}",
                      summary: latencySummary,
                    },
                  )
                : null,
              gateSummary
                ? t(
                    "notifications.presentation.classificationQualityThresholdExceeded.gate",
                    {
                      defaultValue: "Category gates: {{summary}}",
                      summary: gateSummary,
                    },
                  )
                : null,
            ]
              .filter(Boolean)
              .join(" | ")
          : null;
      const body =
        semanticBody ??
        technicalDetail ??
        item.body ??
        t(
          "notifications.presentation.classificationQualityThresholdExceeded.body",
          {
            defaultValue:
              "Classification quality thresholds were exceeded in the {{window}} window. Review system monitoring for details.",
            window,
          },
        );
      return { title, body, toastText: title };
    }
    default:
      return fallback;
  }
};

export const formatNotificationStreamError = (
  error: NotificationStreamErrorPayload | undefined,
  t: Translate,
  fallbackKind: "socket" | "connect" = "socket",
): string => {
  return formatRealtimeSocketError(error, t, {
    keyPrefix: "notifications.connectionError",
    fallbackKind,
    defaults: {
      unauthorized: "Notification connection expired. Please sign in again.",
      tooManyConnections:
        "Notification connections are at capacity. Please try again later.",
      tooManyConnectionAttempts:
        "Too many notification connection attempts. Please try again later.",
      rateLimitExceeded:
        "Too many notification connection attempts. Please try again later.",
      tooManyFailedAttempts:
        "Too many failed notification sign-in attempts. Please try again later.",
      timeout: "Connecting to notifications timed out. Please try again.",
      network:
        "Unable to connect to notifications. Please check the network and try again.",
      connect:
        "Unable to connect to notifications right now. Please try again later.",
      socket: "Notification connection is unstable. Please try again later.",
    },
  });
};

export const resolveNotificationLink = (
  payload: Record<string, unknown> | null | undefined,
  t: Translate,
  options: ResolveNotificationLinkOptions = {},
): NotificationLink | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const presentation = isRecord(payload.presentation)
    ? payload.presentation
    : null;
  const params = isRecord(presentation?.params) ? presentation.params : null;

  const directLink = toStringValue(
    payload.link ??
      payload.href ??
      payload.url ??
      params?.link ??
      params?.href ??
      params?.url,
  );
  if (directLink) {
    return {
      href: directLink,
      label: t("notifications.openLink", { defaultValue: "Open" }),
    };
  }

  const taskId = toStringValue(payload.taskId ?? params?.taskId);
  if (taskId) {
    return {
      href: `/crawl/${taskId}`,
      label: t("notifications.openTask", { defaultValue: "Open task" }),
    };
  }

  const itemId = toStringValue(
    payload.itemId ??
      payload.itemMetaId ??
      payload.processedItemId ??
      params?.itemId ??
      params?.itemMetaId ??
      params?.processedItemId,
  );
  if (itemId) {
    return {
      href: `/items/${itemId}`,
      label: t("notifications.openItem", { defaultValue: "Open item" }),
    };
  }

  const analysisId = toStringValue(payload.analysisId ?? params?.analysisId);
  if (analysisId) {
    return {
      href: `/dashboard?panel=analysis&analysisId=${encodeURIComponent(analysisId)}`,
      label: t("notifications.openAnalysis", { defaultValue: "Open analysis" }),
    };
  }

  const alertEventId = toStringValue(
    payload.alertEventId ??
      payload.eventId ??
      params?.alertEventId ??
      params?.eventId,
  );
  if (alertEventId && options.canReadAlerts !== false) {
    return {
      href: `/alerts?eventId=${encodeURIComponent(alertEventId)}`,
      label: t("notifications.openAlert", { defaultValue: "Open alert" }),
    };
  }

  return null;
};
