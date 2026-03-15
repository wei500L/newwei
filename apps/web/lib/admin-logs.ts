export const ADMIN_LOGS_TABS = ["task", "errors", "audit"] as const;

export type AdminLogsTabId = (typeof ADMIN_LOGS_TABS)[number];

export interface BuildAdminLogsHrefOptions {
  tab?: AdminLogsTabId | null;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export function isAdminLogsTabId(value: string | null | undefined): value is AdminLogsTabId {
  return ADMIN_LOGS_TABS.includes(value as AdminLogsTabId);
}

export function resolveAdminLogsTabId(value: string | null | undefined): AdminLogsTabId {
  return isAdminLogsTabId(value) ? value : "task";
}

export function buildAdminLogsHref({ tab, query }: BuildAdminLogsHrefOptions = {}): string {
  const searchParams = new URLSearchParams();

  if (tab) {
    searchParams.set("tab", tab);
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === false || value === "") {
        continue;
      }

      searchParams.set(key, String(value));
    }
  }

  const search = searchParams.toString();
  return search.length > 0 ? `/admin/logs?${search}` : "/admin/logs";
}

export function buildAdminLogsTabSelectionHref(
  pathname: string | null,
  searchParams: Pick<URLSearchParams, "toString"> | null,
  tab: AdminLogsTabId,
): string {
  const nextSearchParams = new URLSearchParams(searchParams?.toString() ?? "");
  nextSearchParams.set("tab", tab);

  const resolvedPathname = pathname && pathname.trim().length > 0 ? pathname : "/admin/logs";
  const search = nextSearchParams.toString();
  return search.length > 0 ? `${resolvedPathname}?${search}` : resolvedPathname;
}
