import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlTasksView } from "@/app/(app)/crawl/crawl-tasks";

export default async function AdminCrawlTasksPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <CrawlTasksView />;
}
