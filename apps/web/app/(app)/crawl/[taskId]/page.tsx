import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

interface CrawlTaskDetailPageParams {
  taskId: string;
}

export default async function CrawlTaskDetailPage({
  params
}: {
  params: Promise<CrawlTaskDetailPageParams>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const { taskId } = await params;
  redirect(`/admin/ops/crawl-tasks/${taskId}`);
}
