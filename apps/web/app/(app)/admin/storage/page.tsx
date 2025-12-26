import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { StorageSettingsContent } from "./storage-content";

export default async function StorageSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <StorageSettingsContent />;
}
