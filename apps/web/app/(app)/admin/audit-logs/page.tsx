import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AuditLogsContent } from "./audit-logs-content";

export default async function AuditLogsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AuditLogsContent />;
}
