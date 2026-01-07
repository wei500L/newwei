import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { SystemSettingsContent } from "@/app/(app)/settings/system/system-settings-content";

export default async function AdminSystemSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SystemSettingsContent />;
}
