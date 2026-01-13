import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

export default async function CrawlTasksPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const newParam = searchParams?.new;
  const query = newParam ? "?new=true" : "";
  redirect(`/admin/ops/crawl-tasks${query}`);
}
