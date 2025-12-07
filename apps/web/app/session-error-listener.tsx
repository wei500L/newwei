"use client";

import { App } from "antd";
import { useEffect, useRef } from "react";
import { signOut, useSession } from "next-auth/react";

export function SessionErrorListener() {
  const { message } = App.useApp();
  const { data: session, status } = useSession();
  const handledRef = useRef(false);

  useEffect(() => {
    if (status !== "authenticated") {
      handledRef.current = false;
      return;
    }

    if (session?.error === "RefreshAccessTokenError" && !handledRef.current) {
      handledRef.current = true;
      message.error("Session expired. Please sign in again.");
      void signOut({ callbackUrl: "/login?sessionExpired=1" });
    }
  }, [message, session?.error, status]);

  return null;
}
