import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlMonitorContent } from "./crawl-monitor-content";

const ensureDashboardPath = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname || "/";
    if (pathname === "/" || pathname === "") {
      url.pathname = "/dashboard/";
    } else if (pathname === "/dashboard") {
      url.pathname = "/dashboard/";
    } else if (pathname.endsWith("/dashboard")) {
      url.pathname = `${pathname}/`;
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
};

const resolveCrawl4aiDashboardUrl = () => {
  const explicit = process.env.CRAWL4AI_DASHBOARD_URL?.trim();
  if (explicit) {
    return ensureDashboardPath(explicit);
  }

  const base = process.env.CRAWL4AI_BASE_URL?.trim();
  if (!base) {
    return "";
  }

  try {
    return new URL("/dashboard/", base).toString();
  } catch {
    return "";
  }
};

export default async function AdminCrawlMonitorPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const dashboardUrl = resolveCrawl4aiDashboardUrl();
  return <CrawlMonitorContent dashboardUrl={dashboardUrl} />;
}

