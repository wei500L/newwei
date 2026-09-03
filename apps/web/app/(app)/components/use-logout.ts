"use client";

import { signOut } from "next-auth/react";
import { useCallback, useState } from "react";

import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";

export interface UseLogoutResult {
  loggingOut: boolean;
  /** 退出登录：POST /api/logout（带 trace 头）→ next-auth signOut 回登录页 */
  handleLogout: (logoutAll: boolean) => Promise<void>;
}

/** 用户菜单的退出动作（FE-批2 从 TopNav 拆出，流程语义不变）。 */
export function useLogout(): UseLogoutResult {
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = useCallback(async (logoutAll: boolean) => {
    setLoggingOut(true);
    let callbackUrl = "/login";
    try {
      const response = await fetch("/api/logout", {
        method: "POST",
        headers: createTraceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ logoutAll }),
      });

      if (!response.ok) {
        callbackUrl = "/login?logoutFailed=1";
      }
    } catch (error) {
      captureClientError("Logout error", error);
      callbackUrl = "/login?logoutFailed=1";
    } finally {
      setLoggingOut(false);
    }

    await signOut({ callbackUrl });
  }, []);

  return { loggingOut, handleLogout };
}
