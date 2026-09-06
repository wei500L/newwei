"use client";

/**
 * Create Crawl Task 抽屉的扫描模式提示（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 依据 scanFullPage 与根级 virtualScroll.enabled 派生三种扫描模式文案。
 */

import { Alert, Form } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

export function ScanStrategyAlert() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const virtualScrollEnabled = Boolean(
    Form.useWatch(["virtualScroll", "enabled"], form),
  );
  const scanFullPage = Form.useWatch("scanFullPage", form);

  const scanStrategyMode = virtualScrollEnabled
    ? "virtual_scroll"
    : scanFullPage
      ? "full_page"
      : "default";

  return (
    <Alert
      style={{ marginBottom: 16 }}
      showIcon
      type={
        scanStrategyMode === "full_page"
          ? "success"
          : scanStrategyMode === "virtual_scroll"
            ? "info"
            : "warning"
      }
      message={
        scanStrategyMode === "full_page"
          ? t("crawl.settings.scanModes.fullPageTitle")
          : scanStrategyMode === "virtual_scroll"
            ? t("crawl.settings.scanModes.virtualScrollTitle")
            : t("crawl.settings.scanModes.defaultTitle")
      }
      description={
        scanStrategyMode === "full_page"
          ? t("crawl.settings.scanModes.fullPageDescription")
          : scanStrategyMode === "virtual_scroll"
            ? t("crawl.settings.scanModes.virtualScrollDescription")
            : t("crawl.settings.scanModes.defaultDescription")
      }
    />
  );
}
