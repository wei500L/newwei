"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";

/**
 * (app) 路由组内的 404 页（在 shell 内渲染）。
 * 服务端组件无法拿到 i18n 文案（lib/i18n.ts 没有服务端翻译函数），因此这里
 * 用客户端组件 + useTranslation；也避免为 antd Result 引入额外的客户端边界。
 */
export default function AppNotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <p className="kicker m-0">404</p>
      <h1 className="m-0 font-serif text-2xl font-semibold">{t("common.notFound.title")}</h1>
      <p className="m-0 text-sm text-muted-foreground">{t("common.notFound.description")}</p>
      <Link href="/today" className="text-sm text-[var(--primary)] underline-offset-4 hover:underline">
        {t("common.notFound.goHome")}
      </Link>
    </div>
  );
}
