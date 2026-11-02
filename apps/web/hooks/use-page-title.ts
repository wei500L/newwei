"use client";

import { useEffect } from "react";

import { setPageTitle } from "@/lib/document-title";

/** 设置当前页的标签页标题；组件卸载时恢复为只有站点名。title 不是字符串时不做任何事。 */
export function usePageTitle(title: unknown): void {
  const text = typeof title === "string" ? title.trim() : "";
  useEffect(() => {
    if (!text) return;
    setPageTitle(text);
    return () => setPageTitle(null);
  }, [text]);
}
