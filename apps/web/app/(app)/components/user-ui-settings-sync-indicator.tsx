"use client";

import { CloudSyncOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { Button, Popover, Space, Tag, Typography } from "antd";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime, resolveLocale, type SupportedLocale } from "@/lib/i18n";
import { useUserUiSyncStatusStore, type UserUiSyncSectionStatus } from "@/store/user-ui-sync-status";

type OverallState = "idle" | "loading" | "syncing" | "error";

function tText(t: TFunction, key: string, options?: Record<string, unknown>) {
  const value = t(key, options as any);
  return typeof value === "string" ? value : String(value);
}

function resolveOverallState(statuses: UserUiSyncSectionStatus[]): OverallState {
  if (statuses.some((status) => status.state === "error")) {
    return "error";
  }
  if (statuses.some((status) => status.state === "syncing")) {
    return "syncing";
  }
  if (statuses.some((status) => status.state === "loading")) {
    return "loading";
  }
  return "idle";
}

function renderStateTag(state: UserUiSyncSectionStatus["state"], t: TFunction) {
  switch (state) {
    case "error":
      return <Tag color="red">{tText(t, "common.syncError", { defaultValue: "ERROR" })}</Tag>;
    case "syncing":
      return <Tag color="processing">{tText(t, "common.syncing", { defaultValue: "SYNCING" })}</Tag>;
    case "loading":
      return <Tag color="processing">{tText(t, "common.loading", { defaultValue: "LOADING" })}</Tag>;
    case "idle":
    default:
      return <Tag color="green">{tText(t, "common.synced", { defaultValue: "SYNCED" })}</Tag>;
  }
}

function renderLastSynced(
  status: UserUiSyncSectionStatus,
  locale: SupportedLocale,
  t: TFunction
) {
  if (!status.lastSyncedAt) {
    return (
      <Typography.Text type="secondary">
        {tText(t, "common.neverSynced", { defaultValue: "Not synced yet." })}
      </Typography.Text>
    );
  }

  return (
    <Typography.Text type="secondary">
      {tText(t, "common.lastSyncedAt", {
        defaultValue: "Last synced: {{time}}",
        time: formatDateTime(new Date(status.lastSyncedAt), locale, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })}
    </Typography.Text>
  );
}

export function UserUiSettingsSyncIndicator() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const sections = useUserUiSyncStatusStore((state) => state.sections);
  const requestReload = useUserUiSyncStatusStore((state) => state.requestReload);

  const overall = useMemo(
    () => resolveOverallState(Object.values(sections)),
    [sections],
  );

  const title = t("common.syncStatus");

  const icon =
    overall === "error" ? (
      <ExclamationCircleOutlined className="text-red-500" />
    ) : (
      <CloudSyncOutlined spin={overall === "loading" || overall === "syncing"} />
    );

  const content = (
    <Space direction="vertical" size={10} style={{ minWidth: 260 }}>
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <Typography.Text>
            {t("pages.situationMonitor.title")}
          </Typography.Text>
          {renderLastSynced(sections["situation-monitor"], locale, t)}
          {sections["situation-monitor"].state === "error" && sections["situation-monitor"].lastErrorMessage ? (
            <Typography.Text type="danger" ellipsis>
              {sections["situation-monitor"].lastErrorMessage}
            </Typography.Text>
          ) : null}
        </div>
        <Space size={6} align="center">
          {renderStateTag(sections["situation-monitor"].state, t)}
          {sections["situation-monitor"].pending > 0 ? (
            <Tag color="default">{sections["situation-monitor"].pending}</Tag>
          ) : null}
        </Space>
      </div>

      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <Typography.Text>
            {t("pages.map.title")}
          </Typography.Text>
          {renderLastSynced(sections["war-map"], locale, t)}
          {sections["war-map"].state === "error" && sections["war-map"].lastErrorMessage ? (
            <Typography.Text type="danger" ellipsis>
              {sections["war-map"].lastErrorMessage}
            </Typography.Text>
          ) : null}
        </div>
        <Space size={6} align="center">
          {renderStateTag(sections["war-map"].state, t)}
          {sections["war-map"].pending > 0 ? <Tag color="default">{sections["war-map"].pending}</Tag> : null}
        </Space>
      </div>

      <Typography.Text type="secondary">
        {t("common.syncHint")}
      </Typography.Text>

      {overall === "error" ? (
        <Button size="small" onClick={() => requestReload()}>
          {t("common.retry")}
        </Button>
      ) : null}
    </Space>
  );

  return (
    <Popover title={title} content={content} trigger="click" placement="bottomRight">
      <Button type="text" size="small" icon={icon} aria-label={title} />
    </Popover>
  );
}
