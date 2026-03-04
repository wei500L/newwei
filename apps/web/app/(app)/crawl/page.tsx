import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

type CrawlTasksPageSearchParams = Record<string, string | string[] | undefined>;

export default async function CrawlTasksPage({
  searchParams
}: {
  searchParams?: Promise<CrawlTasksPageSearchParams>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const newParam = resolvedSearchParams?.new;
  const query = newParam ? "?new=true" : "";
  redirect(`/admin/ops/crawl-tasks${query}`);
}
