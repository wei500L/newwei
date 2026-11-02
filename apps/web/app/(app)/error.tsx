"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    captureClientError("App route error", error, {
      extras: { digest: error.digest },
    });
  }, [error]);
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Result
        status="error"
        title={t("common.pageError.title")}
        subTitle={t("common.pageError.description")}
        extra={<Button type="primary" onClick={reset}>{t("common.retry")}</Button>}
      />
    </div>
  );
}
