import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SystemSettingsContent } from "./system-settings-content";

export default async function SystemSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SystemSettingsContent />;
}

