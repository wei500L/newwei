"use client";

import { App } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { onForbidden } from "@/lib/auth-events";

export function ForbiddenNotice() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const lastShownAtRef = useRef<number>(0);

  useEffect(() => {
    const unsubscribe = onForbidden((detail) => {
      const now = Date.now();
      if (now - lastShownAtRef.current < 2_500) {
        return;
      }
      lastShownAtRef.current = now;

      const reason = typeof detail?.reason === "string" ? detail.reason.trim() : "";
      message.open({
        key: "access-denied",
        type: "warning",
        content: reason
          ? `${t("common.accessDenied", { defaultValue: "Access denied" })}: ${reason}`
          : t("common.accessDenied", { defaultValue: "Access denied" }),
        duration: 2.2
      });
    });

    return () => {
      unsubscribe();
      lastShownAtRef.current = 0;
    };
  }, [message, t]);

  return null;
}

