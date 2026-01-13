import { redirect } from "next/navigation";

import { CrawlTasksView } from "@/app/(app)/crawl/crawl-tasks";
import { auth } from "@/lib/auth";

export default async function AdminCrawlTasksPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <CrawlTasksView />;
}
