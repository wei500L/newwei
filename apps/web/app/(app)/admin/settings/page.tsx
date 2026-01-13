import { redirect } from "next/navigation";

import { SettingsContent } from "@/app/(app)/settings/settings-content";
import { auth } from "@/lib/auth";

export default async function AdminSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SettingsContent />;
}
