import { redirect } from "next/navigation";

import { SystemSettingsContent } from "@/app/(app)/settings/system/system-settings-content";
import { auth } from "@/lib/auth";

export default async function AdminSystemSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SystemSettingsContent />;
}
