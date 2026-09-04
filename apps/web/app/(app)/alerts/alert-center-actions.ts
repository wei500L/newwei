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
