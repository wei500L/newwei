import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { NewsSourcesContent } from "./news-sources-content";

export default async function AdminNewsSourcesPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <NewsSourcesContent />;
}
