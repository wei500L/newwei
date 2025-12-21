import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlTasksView } from "./crawl-tasks";

export default async function CrawlTasksPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <CrawlTasksView />;
}
