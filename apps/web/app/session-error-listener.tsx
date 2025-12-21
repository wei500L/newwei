"use client";

import { App } from "antd";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export function SessionErrorListener() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const handledRef = useRef(false);

  useEffect(() => {
    if (status !== "authenticated") {
      handledRef.current = false;
      return;
    }

    if (session?.error === "RefreshAccessTokenError" && !handledRef.current) {
      handledRef.current = true;
      message.error(t("auth.sessionExpired"));
      void signOut({ callbackUrl: "/login?sessionExpired=1" });
    }
  }, [message, session?.error, status, t]);

  return null;
}
