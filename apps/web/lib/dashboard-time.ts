import type { ConfigType } from "dayjs";

import dayjs from "@/lib/dayjs";

import { getDefaultTimeZone } from "./time-zone";

export function dashboardNow() {
  return dayjs().tz(getDefaultTimeZone());
}

export function toDashboardZonedTime(value: ConfigType) {
  return dayjs(value).tz(getDefaultTimeZone());
}

export function formatDashboardDate(value: ConfigType): string {
  return toDashboardZonedTime(value).format("YYYY-MM-DD");
}

export function formatDashboardWindowLabel(start: ConfigType, end: ConfigType): string {
  return `${formatDashboardDate(start)} - ${formatDashboardDate(end)}`;
}

