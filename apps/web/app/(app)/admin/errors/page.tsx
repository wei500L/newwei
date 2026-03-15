import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { buildAdminLogsHref } from "@/lib/admin-logs";

export default async function ErrorsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  redirect(buildAdminLogsHref({ tab: "errors" }));
}
