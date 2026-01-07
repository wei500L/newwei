import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

export default async function SystemSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  redirect("/admin/system");
}
