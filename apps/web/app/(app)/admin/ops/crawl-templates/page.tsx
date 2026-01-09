import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { CrawlTemplatesContent } from "./crawl-templates-content";

export default async function AdminCrawlTemplatesPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <CrawlTemplatesContent />;
}

