import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { RssContent } from "./rss-content";

export default async function RssPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <RssContent />;
}
