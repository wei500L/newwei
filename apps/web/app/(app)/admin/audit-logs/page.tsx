import { redirect } from "next/navigation";

import { buildAdminLogsHref } from "@/lib/admin-logs";
import { auth } from "@/lib/auth";

export default async function AuditLogsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  redirect(buildAdminLogsHref({ tab: "audit" }));
}
