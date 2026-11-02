"use client";

import { usePageTitle } from "@/hooks/use-page-title";

export function PageTitleSync({ title }: { title: string }): null {
  usePageTitle(title);
  return null;
}
