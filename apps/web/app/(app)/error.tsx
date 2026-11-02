"use client";

import { Button } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

/**
 * (app) 路由组内的错误页（在 shell 内渲染）。
 * 报纸风：kicker 眉题 + 衬线 h1 + 说明 + 主按钮，与 not-found.tsx 同构。
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    captureClientError("App route error", error, {
      extras: { digest: error.digest },
    });
  }, [error]);
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <p className="kicker m-0">{t("common.pageError.kicker")}</p>
      <h1 className="m-0 font-serif text-2xl font-semibold">
        {t("common.pageError.title")}
      </h1>
      <p className="m-0 text-sm text-muted-foreground">
        {t("common.pageError.description")}
      </p>
      <Button type="primary" onClick={reset}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
