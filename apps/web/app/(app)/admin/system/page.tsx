import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

export default async function AdminSystemSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  redirect("/admin/settings");
}
