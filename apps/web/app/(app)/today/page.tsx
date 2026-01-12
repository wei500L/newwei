import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { TodayContent } from "./today-content";

export default async function TodayPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <TodayContent />;
}
