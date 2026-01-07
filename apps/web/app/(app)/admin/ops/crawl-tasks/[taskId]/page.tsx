import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlTaskDetail } from "@/app/(app)/crawl/[taskId]/task-detail";

interface CrawlTaskDetailPageParams {
  taskId: string;
}

export default async function AdminCrawlTaskDetailPage({
  params
}: {
  params: CrawlTaskDetailPageParams;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <CrawlTaskDetail taskId={params.taskId} />;
}
