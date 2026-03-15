import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AdminLogsContent } from "./admin-logs-content";

export default async function AdminLogsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AdminLogsContent />;
}
