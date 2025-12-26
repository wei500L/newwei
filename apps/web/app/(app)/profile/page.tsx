import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { ProfileContent } from "./profile-content";

export default async function ProfilePage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ProfileContent />;
}
