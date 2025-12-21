import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { OrgAdminContent } from "./orgs-content";

export default async function OrgsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <OrgAdminContent />;
}

