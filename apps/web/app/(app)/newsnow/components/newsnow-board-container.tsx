"use client";

import type { ReactNode } from "react";

import { PageContainer } from "../../components/page-container";

/**
 * NewsnowBoardContainer：newsnow 看板的内容容器（App Shell 第一批收敛）。
 *
 * 此前 newsnow 页面在 12 处私自硬编码 `max-w-[1760px] px-4 … xl:px-8`，
 * 与 shell 的宽度白名单并行成两套布局策略。收敛后：
 *   - 宽度档位（wide-board=1760px）统一由 PageContainer 提供；
 *   - 本组件只保留 newsnow 特有的边距节奏（px-4 md:px-6 xl:px-8）；
 *   - shell 层维持 edge-to-edge（p-0），由页面内容自管 padding。
 */
interface NewsnowBoardContainerProps {
  children: ReactNode;
  /** 纵向节奏变体（对齐原各处的 pt/pb 组合）。 */
  spacing?: "header" | "content" | "section" | "footer";
  className?: string;
}

const SPACING_CLASSES: Record<NonNullable<NewsnowBoardContainerProps["spacing"]>, string> = {
  header: "py-3 md:py-4",
  content: "pb-8 pt-6 md:pb-9 md:pt-7",
  section: "pt-4",
  footer: "pb-7 pt-3",
};

export function NewsnowBoardContainer({
  children,
  spacing = "content",
  className = "",
}: NewsnowBoardContainerProps) {
  return (
    <PageContainer
      contentWidth="wide-board"
      padding="none"
      className={`px-4 md:px-6 xl:px-8 ${SPACING_CLASSES[spacing]} ${className}`.trim()}
    >
      {children}
    </PageContainer>
  );
}
