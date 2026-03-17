import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlFrontierContent } from "./crawl-frontier-content";

export default async function AdminCrawlFrontierPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <CrawlFrontierContent />;
}
