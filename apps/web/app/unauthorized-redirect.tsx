"use client";

import { App } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { onUnauthorized } from "@/lib/auth-events";

export function UnauthorizedRedirect() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const router = useRouter();
  const redirectingRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = onUnauthorized(() => {
      if (redirectingRef.current) {
        return;
      }

      redirectingRef.current = true;
      message.open({
        key: "session-expired",
        type: "loading",
        content: t("auth.sessionExpiredRedirect"),
        duration: 0.8
      });

      timeoutRef.current = window.setTimeout(() => {
        router.push("/login?sessionExpired=1");
      }, 650);
    });

    return () => {
      unsubscribe();
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = null;
      redirectingRef.current = false;
    };
  }, [message, router, t]);

  return null;
}
