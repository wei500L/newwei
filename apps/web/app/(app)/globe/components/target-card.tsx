"use client";

import { Button, Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import type { TargetView } from "@/lib/globe/target-format";
import { safeHttpUrl } from "@/lib/url";

export interface TargetCardProps {
  view: TargetView;
  /** 图层显示名（由 live 容器传入 shownLayerName 的结果）。 */
  layerName: string;
  /** 该图层是否支持跟踪。 */
  tracking: boolean;
  /** 当前是否处于跟踪状态。 */
  isTracked: boolean;
  onTrack: () => void;
  onUntrack: () => void;
  onFlyTo: () => void;
  onClose: () => void;
  /** G5：是否可进入驾驶舱（`useCockpitStore().presence?.entryAvailable`）。 */
  cockpitEntryAvailable?: boolean;
  /** G5：点击「进入驾驶舱」（通常触发骨架里的 `#cockpit-entry`）。 */
  onEnterCockpit?: () => void;
  /** G6：点击主按钮（打开事件 / 新闻详情），参数是要跳转的 href。 */
  onOpenConsole?: (href: string) => void;
}

/**
 * 目标详情卡（纯展示）。数据与动作由 `target-card-container.tsx` 提供，
 * 这样卡片可以在 jsdom 里用模拟的 `TargetView` 单测。
 */
export function TargetCard({
  view,
  layerName,
  tracking,
  isTracked,
  onTrack,
  onUntrack,
  onFlyTo,
  onClose,
  cockpitEntryAvailable = false,
  onEnterCockpit,
  onOpenConsole,
}: TargetCardProps) {
  const { t } = useTranslation();
  const searchHref = `/search?q=${encodeURIComponent(view.title)}`;
  const consoleAction = view.console;
  // 外部原文不信任 GeoJSON 里的字符串，渲染前再校验一次。
  const externalHref = consoleAction?.external
    ? safeHttpUrl(consoleAction.href)
    : null;

  return (
    <section
      aria-label={t("globe.target.aria")}
      className="flex max-h-full min-h-0 flex-col"
    >
      <header className="flex items-start justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <div className="min-w-0">
          <p className="kicker m-0 truncate">{layerName}</p>
          <h2 className="m-0 truncate font-serif text-lg text-slate-100" title={view.title}>
            {view.title}
          </h2>
          {view.subtitle ? (
            <p className="m-0 truncate font-mono text-xs text-slate-400">
              {view.subtitle}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={t("globe.target.close")}
          className="shrink-0 rounded p-1 text-lg leading-none text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="rail-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view.fields.length > 0 ? (
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2">
            {view.fields.map((field, index) => (
              <div key={`${field.labelKey}:${index}`} className="min-w-0">
                <dt className="text-xs text-slate-400">
                  {t(field.labelKey, { defaultValue: field.labelKey })}
                </dt>
                <dd
                  className={`m-0 break-words text-sm text-slate-100 ${
                    field.mono ? "font-mono" : ""
                  }`}
                >
                  {field.tagColor ? (
                    <Tag color={field.tagColor}>{field.value}</Tag>
                  ) : (
                    field.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="m-0 text-xs text-slate-400">{t("globe.target.noFields")}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {consoleAction?.external ? (
            externalHref ? (
              <Button
                size="small"
                type="primary"
                href={externalHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t(consoleAction.labelKey, {
                  defaultValue: consoleAction.labelKey,
                })}
              </Button>
            ) : null
          ) : consoleAction && onOpenConsole ? (
            <Button
              size="small"
              type="primary"
              onClick={() => onOpenConsole(consoleAction.href)}
            >
              {t(consoleAction.labelKey, {
                defaultValue: consoleAction.labelKey,
              })}
            </Button>
          ) : null}
          {tracking ? (
            <Button
              size="small"
              onClick={isTracked ? onUntrack : onTrack}
            >
              {isTracked
                ? t("globe.target.actions.untrack")
                : t("globe.target.actions.track")}
            </Button>
          ) : null}
          <Button size="small" onClick={onFlyTo}>
            {t("globe.target.actions.flyTo")}
          </Button>
          <Tooltip
            title={
              cockpitEntryAvailable
                ? undefined
                : t("globe.target.actions.cockpitHint")
            }
          >
            <span>
              <Button
                size="small"
                disabled={!cockpitEntryAvailable}
                onClick={onEnterCockpit}
              >
                {t("globe.target.actions.cockpit")}
              </Button>
            </span>
          </Tooltip>
          <Button size="small" href={searchHref}>
            {t("globe.target.actions.search")}
          </Button>
        </div>

        {view.links.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {view.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-sky-400 underline-offset-2 hover:underline"
              >
                {t(link.labelKey, { defaultValue: link.labelKey })}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
