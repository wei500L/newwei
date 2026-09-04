import {
  buildCsv,
  downloadCsv,
  downloadTextFile,
  formatDateForFilename,
} from "@/lib/data-export";

import {
  buildAlertExportJson,
  buildAlertExportRows,
  type AlertEventItem,
} from "./alert-center.utils";
import { safeJsonStringify, type TranslateFn } from "./evidence-utils";

/**
 * Alert Center 剪贴板与导出域行为（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - createCopyRawContextHandler：复制原始 context JSON + 成功/失败提示；
 * - createExportHandlers：CSV/JSON 下载（scope/includeRaw 语义保持）。
 * messageApi 由编排层注入（其 useMessage 上下文已渲染）。
 */

export interface AlertFeedbackMessageApi {
  success: (content: string) => void;
  error: (content: string) => void;
}

/** 复制 Markdown 的载荷构造（字段与既有输出逐行一致）。 */
export function buildAlertMarkdownPayload(options: {
  selectedEvent: AlertEventItem;
  context: Record<string, unknown> | null;
  locale: string;
  t: TranslateFn;
  formatDateTime: (
    value: string | number,
    locale: string,
    opts: Record<string, unknown>,
  ) => string;
  metricProviderLabel: (provider: string | null | undefined) => string;
  thresholdSummary: string;
}): string {
  const { selectedEvent, context, locale, t, formatDateTime, metricProviderLabel, thresholdSummary } =
    options;

  const markdownLines = [
    `# ${t("alerts.center.markdown.title")}`,
    "",
    `- **ID**: ${selectedEvent.id}`,
    `- **${t("alerts.center.detail.triggeredAt")}**: ${formatDateTime(
      selectedEvent.triggeredAt,
      locale,
      {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      },
    )}`,
    `- **${t("alerts.center.detail.rule")}**: ${selectedEvent.ruleName ?? t("common.notAvailable")}`,
    `- **${t("alerts.center.detail.metric", { metric: "" })}**: ${selectedEvent.metricSlug ?? t("common.notAvailable")}`,
    `- **${t("alerts.center.detail.provider", { provider: "" })}**: ${metricProviderLabel(selectedEvent.metricProvider)}`,
    `- **${t("alerts.center.detail.status")}**: ${selectedEvent.status}`,
    `- **${t("alerts.center.detail.metricValue")}**: ${selectedEvent.metricValue}`,
    `- **${t("alerts.center.detail.threshold")}**: ${thresholdSummary}`,
    "",
    `## ${t("alerts.center.detail.message")}`,
    selectedEvent.message ?? t("alerts.events.triggered"),
    "",
    `## ${t("alerts.center.detail.context")}`,
    "```json",
    safeJsonStringify(context ?? {}),
    "```",
    "",
    `## ${t("alerts.center.detail.deliveries")}`,
  ];

  if (selectedEvent.deliveries.length === 0) {
    markdownLines.push(`- ${t("alerts.center.deliveriesEmpty")}`);
  } else {
    selectedEvent.deliveries.forEach((delivery) => {
      markdownLines.push(
        `- ${delivery.status} · ${delivery.channelType} · ${delivery.channelName ?? delivery.target ?? t("common.notAvailable")}`,
      );
    });
  }

  return markdownLines.join("\n");
}

export function createCopyAlertMarkdownHandler(options: {
  selectedEvent: AlertEventItem | null;
  context: Record<string, unknown> | null;
  locale: string;
  messageApi: AlertFeedbackMessageApi;
  t: TranslateFn;
  formatDateTime: (
    value: string | number,
    locale: string,
    opts: Record<string, unknown>,
  ) => string;
  metricProviderLabel: (provider: string | null | undefined) => string;
  thresholdSummary: string;
}) {
  const { selectedEvent, messageApi, t } = options;
  return async () => {
    if (!selectedEvent) {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        buildAlertMarkdownPayload({ ...options, selectedEvent }),
      );
      messageApi.success(t("alerts.center.markdown.copied"));
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("alerts.center.contextCopyFailed"),
      );
    }
  };
}

export function createCopyRawContextHandler(
  context: Record<string, unknown> | null,
  { messageApi, t }: { messageApi: AlertFeedbackMessageApi; t: TranslateFn },
) {
  return async () => {
    if (!context) {
      return;
    }
    try {
      await navigator.clipboard.writeText(safeJsonStringify(context));
      messageApi.success(t("alerts.center.contextCopied"));
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("alerts.center.contextCopyFailed"),
      );
    }
  };
}

export function createExportHandlers(options: {
  getExportEvents: () => AlertEventItem[];
  includeRawExport: boolean;
  messageApi: AlertFeedbackMessageApi;
  t: TranslateFn;
}) {
  const { getExportEvents, includeRawExport, messageApi, t } = options;

  const exportCsv = async () => {
    const events = getExportEvents();
    if (events.length === 0) {
      return;
    }
    try {
      const rows = buildAlertExportRows(events, {
        includeContext: includeRawExport,
        includeDeliveries: includeRawExport,
      });
      const csv = await buildCsv(rows);
      const filename = `alerts-${formatDateForFilename(new Date())}.csv`;
      downloadCsv({ csv, filename });
      messageApi.success(t("alerts.center.export.success"));
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : t("alerts.center.export.failed"),
      );
    }
  };

  const exportJson = () => {
    const events = getExportEvents();
    if (events.length === 0) {
      return;
    }
    try {
      const filename = `alerts-${formatDateForFilename(new Date())}.json`;
      const payload = JSON.stringify(
        buildAlertExportJson(events, {
          includeContext: includeRawExport,
          includeDeliveries: includeRawExport,
        }),
        null,
        2,
      );
      downloadTextFile(payload, filename, "application/json;charset=utf-8");
      messageApi.success(t("alerts.center.export.success"));
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : t("alerts.center.export.failed"),
      );
    }
  };

  return { exportCsv, exportJson };
}
