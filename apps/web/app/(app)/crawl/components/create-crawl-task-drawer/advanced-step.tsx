"use client";

/**
 * Create Crawl Task 抽屉的高级配置步组合（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 只组合领域 section，不承载字段实现；渲染顺序与拆分前实现一致。
 */

import { BrowserConfigFields } from "./browser-config-fields";
import { BrowserIdentityFields } from "./browser-identity-fields";
import { DynamicContentFields } from "./dynamic-content-fields";
import { GeneralCrawlFields } from "./general-crawl-fields";
import { LinkPreviewFields } from "./link-preview-fields";
import { MarkdownFields } from "./markdown-fields";
import { MultiUrlFields } from "./multi-url-fields";
import { OptimizationFields } from "./optimization-fields";
import { ScanStrategyAlert } from "./scan-strategy-alert";
import { SessionProxyFields } from "./session-proxy-fields";
import { TableExtractionFields } from "./table-extraction-fields";
import { VirtualScrollFields } from "./virtual-scroll-fields";

export interface AdvancedStepProps {
  canWriteItems: boolean;
}

export function AdvancedStep({ canWriteItems }: AdvancedStepProps) {
  return (
    <>
      <GeneralCrawlFields canWriteItems={canWriteItems} />
      <VirtualScrollFields />
      <ScanStrategyAlert />
      <OptimizationFields />
      <DynamicContentFields />
      <MarkdownFields />
      <TableExtractionFields />
      <LinkPreviewFields />
      <MultiUrlFields />
      <BrowserConfigFields />
      <BrowserIdentityFields />
      <SessionProxyFields />
    </>
  );
}
