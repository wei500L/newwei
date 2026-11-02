"use client";

import { useTranslation } from "react-i18next";

/**
 * 认证页报头：kicker 文字 + 其下方的双线（2px 墨线 + 3px 间隔 + 1px 墨线）。
 * 只在 (auth) 布局内使用，不抽成通用原语。
 */
export function AuthMasthead() {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <p className="kicker m-0 text-center">{t("auth.masthead")}</p>
      <div
        aria-hidden
        className="h-[6px] w-48 border-y-2 border-[var(--border-strong)] [border-bottom-width:1px]"
      />
    </div>
  );
}
