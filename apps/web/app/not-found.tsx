"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";

/**
 * 根级 404 页（shell 之外，例如 portal 的未知路径）。
 * 与 (app)/not-found 同构，外层加整屏纸底容器，链接回到站点根。
 */
export default function RootNotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[100dvh] bg-[var(--background)] p-6">
      <div className="flex w-full flex-col items-center justify-center gap-3 text-center">
        <p className="kicker m-0">404</p>
        <h1 className="m-0 font-serif text-2xl font-semibold">{t("common.notFound.title")}</h1>
        <p className="m-0 text-sm text-muted-foreground">{t("common.notFound.description")}</p>
        <Link href="/" className="text-sm text-[var(--primary)] underline-offset-4 hover:underline">
          {t("common.notFound.goHome")}
        </Link>
      </div>
    </div>
  );
}
