import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlTaskDetail } from "./task-detail";

interface CrawlTaskDetailPageParams {
  taskId: string;
}

export default async function CrawlTaskDetailPage({
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
