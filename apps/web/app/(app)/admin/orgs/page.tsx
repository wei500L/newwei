import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { OrgAdminContent } from "./orgs-content";

export default async function OrgsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <OrgAdminContent />;
}

